import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import dotenv from 'dotenv';

dotenv.config({override: true});
import express from 'express';
import multer from 'multer';
import {createThinkingAudio} from './thinking-audio.js';

import {
    createConfiguredAcpSessionFactory,
    createCallSessionFactory,
    createOpenAiSpeechAdapters,
    VoiceCallError,
    VoiceCallService,
    TargetNotFoundError,
} from '../../src/index.js';

const directory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(directory, '../..');
const configPath = resolve(rootDirectory, process.env.ACP_PHONE_CONFIG ?? 'acp-phone.config.json');
const config = await loadConfig(configPath);
const maxAudioBytes = config.limits?.maxAudioBytes ?? 10 * 1024 * 1024;
const allowedAudioTypes = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav']);

const openAiApiKey = requiredEnvironment('OPENAI_API_KEY');
const openAiBaseURL = requiredEnvironment('OPENAI_BASE_URL');

const speechAdapters = createOpenAiSpeechAdapters({
    apiKey: openAiApiKey,
    baseURL: openAiBaseURL,
    transcriptionModel: process.env.OPENAI_STT_MODEL,
    presentationModel: process.env.OPENAI_REPLY_MODEL,
    ttsModel: process.env.OPENAI_TTS_MODEL,
    voice: process.env.OPENAI_TTS_VOICE,
});
const callSessions = createCallSessionFactory({
    storePath: resolve(rootDirectory, config.sessionStorePath ?? ".acp-phone/sessions.json"),
    factory: createConfiguredAcpSessionFactory({targets: config.targets, baseDirectory: rootDirectory}),
});
const voiceCallService = new VoiceCallService({
    ...speechAdapters,
    acpSessionFactory: callSessions,
    onProgress: logVoiceProgress,
});

const app = express();
const thinkingAudio = createThinkingAudio({
    present: speechAdapters.waitingPresenter.present,
    synthesize: speechAdapters.textToSpeech.synthesize,
    synthesizeStream: speechAdapters.textToSpeech.synthesizeStream,
});
app.post('/api/thinking-audio', express.json({limit: '8kb'}), async (request, response, next) => {
    const controller = new AbortController();
    response.once('close', () => {if (!response.writableEnded) controller.abort();});
    try {
        const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
        response.set({'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no'});
        response.flushHeaders();
        await thinkingAudio({
            transcript: bounded(request.body?.transcript, 1000), draft: bounded(request.body?.draft, 500),
            previous: bounded(request.body?.previous, 180), language: bounded(request.body?.language, 20),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
            onAudio: audio => {if (!controller.signal.aborted) response.write(`${JSON.stringify(audio)}\n`);},
        });
        if (!controller.signal.aborted) response.end();
    } catch (error) {
        if (controller.signal.aborted) return;
        if (response.headersSent) response.end();
        else next(error);
    }
});
const serverInstanceId = crypto.randomUUID();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {fileSize: maxAudioBytes, files: 1},
    fileFilter: (_request, file, callback) => {
        callback(null, allowedAudioTypes.has(file.mimetype));
    },
});

app.use(express.static(resolve(directory, 'public'), {extensions: ['html']}));
app.get('/api/health', (_request, response) => {
    response.set('Cache-Control', 'no-store').json({instanceId: serverInstanceId});
});
app.get('/api/targets', (_request, response) => {
    response.json({targets: config.targets.map(({id, label}) => ({id, label}))});
});

app.post('/api/calls/:targetId/transcription', upload.single('audio'), async (request, response, next) => {
    const controller = new AbortController();
    response.once('close', () => {
        if (!response.writableEnded) controller.abort();
    });
    try {
        if (!config.targets.some((target) => target.id === request.params.targetId)) {
            throw new TargetNotFoundError(request.params.targetId);
        }
        if (!request.file) {
            throw new VoiceCallError('Upload a supported audio file as "audio".', {code: 'AUDIO_REQUIRED', status: 400});
        }
        const transcript = await speechAdapters.speechToText.transcribe({
            audio: {bytes: request.file.buffer, filename: request.file.originalname || 'preview.wav', contentType: request.file.mimetype},
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        response.set('Cache-Control', 'no-store').json({transcript});
    } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        if (error instanceof VoiceCallError) return next(error);
        next(new VoiceCallError('Live transcription is unavailable. Text will appear after your pause.', {
            code: 'LIVE_TRANSCRIPTION_UNAVAILABLE', status: 502, cause: error,
        }));
    }
});

app.post('/api/calls/:targetId/:callId/resume', async (request, response, next) => {
    try {
        if (!config.targets.some((target) => target.id === request.params.targetId)) {
            throw new TargetNotFoundError(request.params.targetId);
        }
        const session = await callSessions.resume({
            target: {id: request.params.targetId}, call: {id: request.params.callId},
        });
        await session?.close();
        response.sendStatus(204);
    } catch (error) { next(error); }
});

app.delete('/api/calls/:targetId/:callId', async (request, response, next) => {
    try {
        await callSessions.end({target: {id: request.params.targetId}, call: {id: request.params.callId}});
        response.sendStatus(204);
    } catch (error) { next(error); }
});

app.post('/api/calls/:targetId/turn', upload.single('audio'), async (request, response, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    try {
        if (!request.file) throw new VoiceCallError('Upload a supported audio file as "audio".', {
            code: 'AUDIO_REQUIRED',
            status: 400
        });
        console.log('[ACP Phone] turn.received', {
            requestId,
            callId: request.body.callId ?? 'unknown',
            targetId: request.params.targetId,
            audioBytes: request.file.size,
            contentType: request.file.mimetype,
        });
        const result = await voiceCallService.handleAudioTurn({
            audio: {
                bytes: request.file.buffer,
                filename: request.file.originalname || 'turn.webm',
                contentType: request.file.mimetype,
            },
            target: {id: request.params.targetId},
            call: {id: request.body.callId, locale: request.body.locale},
            signal: request.signal,
        });
        console.log('[ACP Phone] turn.responded', {
            requestId,
            callId: request.body.callId ?? 'unknown',
            targetId: request.params.targetId,
            durationMs: Math.round(performance.now() - startedAt),
            timings: result.timings,
            responseAudioBytes: result.audio.bytes.length,
        });
        response
            .set({
                'Content-Type': result.audio.contentType,
                'Content-Disposition': `inline; filename="${result.audio.filename}"`,
                'X-Acp-Transcript': encodeURIComponent(result.transcript),
                'X-Acp-Agent-Text': encodeURIComponent(result.agentText),
                'X-Acp-Spoken-Text': encodeURIComponent(result.spokenText),
            })
            .send(result.audio.bytes);
    } catch (error) {
        error.requestId = requestId;
        error.targetId = request.params.targetId;
        error.callId = request.body?.callId ?? 'unknown';
        next(error);
    }
});

app.post('/api/calls/:targetId/turn/stream', upload.single('audio'), async (request, response, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    const controller = new AbortController();
    request.once('aborted', () => controller.abort(new Error('Browser cancelled the voice turn.')));
    response.once('close', () => {
        if (!response.writableEnded) controller.abort(new Error('Browser disconnected.'));
    });
    try {
        if (!request.file) throw new VoiceCallError('Upload a supported audio file as "audio".', {
            code: 'AUDIO_REQUIRED', status: 400,
        });
        console.log('[ACP Phone] stream.received', {
            requestId,
            callId: request.body.callId ?? 'unknown',
            targetId: request.params.targetId,
            audioBytes: request.file.size,
            contentType: request.file.mimetype,
        });
        response.status(200).set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        for await (const event of voiceCallService.handleAudioTurnStream({
            audio: {
                bytes: request.file.buffer,
                filename: request.file.originalname || 'turn.webm',
                contentType: request.file.mimetype,
            },
            target: {id: request.params.targetId},
            call: {id: request.body.callId, locale: request.body.locale},
            signal: controller.signal,
        })) {
            if (controller.signal.aborted) break;
            response.write(`${JSON.stringify(event)}\n`);
        }
        console.log('[ACP Phone] stream.completed', {
            requestId,
            callId: request.body.callId ?? 'unknown',
            targetId: request.params.targetId,
            durationMs: Math.round(performance.now() - startedAt),
        });
        response.end();
    } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        console.error('[ACP Phone] stream.failed', {
            requestId,
            callId: request.body?.callId ?? 'unknown',
            targetId: request.params.targetId,
            message: error.message,
            cause: error.cause?.message,
        });
        if (response.headersSent) {
            response.write(`${JSON.stringify({type: 'error', code: error.code ?? 'INTERNAL_ERROR', message: error.message})}\n`);
            response.end();
            return;
        }
        error.requestId = requestId;
        error.targetId = request.params.targetId;
        error.callId = request.body?.callId ?? 'unknown';
        next(error);
    }
});

app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
        response.status(413).json({
            error: {
                code: 'AUDIO_TOO_LARGE',
                message: 'Audio exceeds the configured upload limit.'
            }
        });
        return;
    }
    const status = error instanceof VoiceCallError ? error.status : 500;
    const code = error instanceof VoiceCallError ? error.code : 'INTERNAL_ERROR';
    console.error('[ACP Phone] turn.failed', {
        requestId: error.requestId ?? 'unknown',
        callId: error.callId ?? 'unknown',
        targetId: error.targetId ?? 'unknown',
        status,
        code,
        message: error.message,
        cause: error.cause?.message,
    });
    response.status(status).json({error: {code, message: error.message || 'Voice turn failed.'}});
});

const port = Number(process.env.ACP_PHONE_PORT ?? 3000);
const server = app.listen(port, () => {
    console.log(`ACP Phone example listening at http://localhost:${port}`);
    console.log('[ACP Phone] configured ACP targets', config.targets.map(({id, label, command, cwd}) => ({id, label, command, cwd})));
    console.log('[ACP Phone] voice turns use automatic end-of-speech detection, then STT → streaming ACP → sentence TTS.');
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    server.close();
    server.closeAllConnections();
    try {
        await callSessions.close();
        process.exit(0);
    } catch (error) {
        console.error('[ACP Phone] shutdown.failed', {message: error.message});
        process.exit(1);
    }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function logVoiceProgress(event) {
    console.log(`[ACP Phone] ${event.stage}`, Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== 'stage'),
    ));
}

async function loadConfig(path) {
    try {
        const config = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(config.targets) || config.targets.length === 0) {
            throw new Error('targets must be a non-empty array');
        }
        return config;
    } catch (cause) {
        throw new Error(`Could not load ACP Phone configuration from ${path}: ${cause.message}`, {cause});
    }
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required. Copy .env.example to .env and set it.`);
    return value;
}
