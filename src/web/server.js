import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import multer from 'multer';
import {createThinkingAudio} from './thinking-audio.js';
import {createConfiguredAcpSessionFactory} from '../adapters/acp/configured-session-factory.js';
import {createCallSessionFactory} from '../application/call-session-factory.js';
import {createOpenAiSpeechAdapters} from '../adapters/openai/openai-speech-adapters.js';
import {VoiceCallService} from '../application/voice-call-service.js';
import {VoiceCallError, TargetNotFoundError} from '../domain/errors.js';

const directory = dirname(fileURLToPath(import.meta.url));

/** Mountable HTTP app. Importing this module never starts a server or reads .env/config files. */
export function createAcpPhoneApp({contacts, speech, environment = {}, baseDirectory = process.cwd(),
    sessionStorePath = '.acp-phone/sessions.json', limits = {}, acpSessionFactory,
    onProgress = () => {}, logger = console} = {}) {
    if (!Array.isArray(contacts) || !contacts.length
        || contacts.some(contact => !contact || typeof contact.id !== 'string' || !contact.id.trim()
            || typeof contact.label !== 'string' || !contact.label.trim())
        || new Set(contacts.map(contact => contact.id)).size !== contacts.length) {
        throw new TypeError('contacts must contain unique IDs and nonempty labels.');
    }
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)
        || !Object.values(environment).every(value => typeof value === 'string')) {
        throw new TypeError('environment must contain string values.');
    }
    for (const contact of contacts) {
        if (contact.environment !== undefined && (!contact.environment || typeof contact.environment !== 'object'
            || Array.isArray(contact.environment) || !Object.values(contact.environment).every(value => typeof value === 'string'))) {
            throw new TypeError(`Contact "${contact.id}" environment must contain string values.`);
        }
    }
    const env = {...environment, ...process.env};
    const speechAdapters = createOpenAiSpeechAdapters({
        apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL,
        transcriptionModel: env.OPENAI_STT_MODEL, presentationModel: env.OPENAI_REPLY_MODEL,
        ttsModel: env.OPENAI_TTS_MODEL, voice: env.OPENAI_TTS_VOICE,
        ...speech,
    });
    const callSessions = createCallSessionFactory({
        storePath: sessionStorePath ? resolve(baseDirectory, sessionStorePath) : undefined,
        factory: acpSessionFactory ?? createConfiguredAcpSessionFactory({
            targets: contacts.map(contact => ({...contact, environment: {...env, ...contact.environment}})),
            baseDirectory,
        }),
    });
    const voiceCallService = new VoiceCallService({...speechAdapters, acpSessionFactory: callSessions, onProgress});
    const maxAudioBytes = limits.maxAudioBytes ?? 10 * 1024 * 1024;
    const allowedAudioTypes = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
    const app = express();
    app.post('/api/greeting-audio', express.json({limit: '1kb'}), async (request, response, next) => {
        const controller = new AbortController();
        response.once('close', () => {if (!response.writableEnded) controller.abort();});
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
            const previous = typeof request.body?.previous === 'string' ? request.body.previous.slice(0, 30) : '';
            const text = await speechAdapters.greetingPresenter.present({previous, signal});
            signal.throwIfAborted();
            const audio = await speechAdapters.textToSpeech.synthesize({text, signal});
            if (!controller.signal.aborted) response.set('Cache-Control', 'no-store').json({
                text, contentType: audio.contentType, audioBase64: audio.bytes.toString('base64'),
            });
        } catch (error) {if (!controller.signal.aborted) next(error);}
    });
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

    app.get('/acp-phone.js', (_request, response) => response.sendFile(resolve(directory, 'client.js')));
    app.get('/skins.js', (_request, response) => response.sendFile(resolve(directory, 'skins.js')));
    app.get('/browser-id.js', (_request, response) => response.sendFile(resolve(directory, 'browser-id.js')));
    app.get('/call', (_request, response) => response.sendFile(resolve(directory, 'public/index.html')));
    app.use(express.static(resolve(directory, 'public'), {index: false}));
    app.get('/api/health', (_request, response) => {
        response.set('Cache-Control', 'no-store').json({instanceId: serverInstanceId});
    });
    app.get('/api/targets', (_request, response) => {
        response.json({targets: contacts.map(({id, label}) => ({id, label}))});
    });
    app.get('/api/contacts', (_request, response) => {
        response.set('Cache-Control', 'no-store').json({contacts: contacts.map(({id, label}) => ({id, label}))});
    });

    app.post('/api/calls/:targetId/transcription', upload.single('audio'), async (request, response, next) => {
        const controller = new AbortController();
        response.once('close', () => {
            if (!response.writableEnded) controller.abort();
        });
        try {
            if (!contacts.some((target) => target.id === request.params.targetId)) {
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
            if (!contacts.some((target) => target.id === request.params.targetId)) {
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
            logger.log('[ACP Phone] turn.received', {
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
            logger.log('[ACP Phone] turn.responded', {
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
            logger.log('[ACP Phone] stream.received', {
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
            logger.log('[ACP Phone] stream.completed', {
                requestId,
                callId: request.body.callId ?? 'unknown',
                targetId: request.params.targetId,
                durationMs: Math.round(performance.now() - startedAt),
            });
            response.end();
        } catch (error) {
            if (controller.signal.aborted || response.destroyed) return;
            logger.error('[ACP Phone] stream.failed', {
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
        logger.error('[ACP Phone] turn.failed', {
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

    return {app, close: () => callSessions.close()};
}
