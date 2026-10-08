import {ValidationError, VoiceCallError} from '../domain/errors.js';

const DEFAULT_MAX_SPOKEN_CHARACTERS = 1_500;

/**
 * Coordinates one completed, turn-based voice interaction.
 * Every collaborator is a port, so hosts can replace OpenAI or ACP transports.
 */
export class VoiceCallService {
    constructor({
                    speechToText,
                    acpSessionFactory,
                    replyPresenter,
                    textToSpeech,
                    maxSpokenCharacters = DEFAULT_MAX_SPOKEN_CHARACTERS,
                    now = () => performance.now(),
                    onProgress = () => {},
                }) {
        if (!speechToText?.transcribe) throw new TypeError('speechToText.transcribe is required.');
        if (!acpSessionFactory?.open) throw new TypeError('acpSessionFactory.open is required.');
        if (!replyPresenter?.present) throw new TypeError('replyPresenter.present is required.');
        if (!textToSpeech?.synthesize) throw new TypeError('textToSpeech.synthesize is required.');
        if (typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');

        this.speechToText = speechToText;
        this.acpSessionFactory = acpSessionFactory;
        this.replyPresenter = replyPresenter;
        this.textToSpeech = textToSpeech;
        this.maxSpokenCharacters = maxSpokenCharacters;
        this.now = now;
        this.onProgress = onProgress;
    }

    async handleAudioTurn({audio, target, call = {}, signal} = {}) {
        validateInput({audio, target});
        const timings = {};
        const progress = (stage, details = {}) => {
            try {
                this.onProgress({
                    stage,
                    callId: call.id ?? 'unknown',
                    targetId: target.id,
                    ...details,
                });
            } catch {
                // Observability must not change the outcome of a voice turn.
            }
        };

        progress('stt.started', {audioBytes: audio.bytes.length, contentType: audio.contentType});
        const transcriptionStartedAt = this.now();
        const transcript = normalizeText(await this.speechToText.transcribe({audio, locale: call.locale, signal}));
        timings.transcriptionMs = elapsed(this.now(), transcriptionStartedAt);
        progress('stt.completed', {durationMs: timings.transcriptionMs, transcriptCharacters: transcript.length});

        if (!hasRecognizedSpeech(transcript)) {
            throw new ValidationError('No speech was recognized in the submitted audio.');
        }

        progress('acp.connecting');
        const agentStartedAt = this.now();
        const session = await this.acpSessionFactory.open({target, call, signal});
        progress('acp.connected');
        let agentText;
        try {
            progress('acp.prompting', {transcriptCharacters: transcript.length});
            agentText = normalizeText(await session.prompt({text: transcript, call, signal}));
        } finally {
            await session.close?.();
        }
        timings.agentMs = elapsed(this.now(), agentStartedAt);
        progress('acp.completed', {durationMs: timings.agentMs, responseCharacters: agentText?.length ?? 0});

        if (!agentText) {
            throw new VoiceCallError('The ACP agent completed without a text response.', {
                code: 'ACP_EMPTY_RESPONSE',
                status: 502,
            });
        }

        progress('presentation.started');
        const presentationStartedAt = this.now();
        const spokenText = normalizeText(await this.replyPresenter.present({
            agentText,
            transcript,
            call,
            signal,
            maxCharacters: this.maxSpokenCharacters,
        }));
        timings.presentationMs = elapsed(this.now(), presentationStartedAt);
        progress('presentation.completed', {durationMs: timings.presentationMs, spokenCharacters: spokenText.length});

        if (!spokenText) {
            throw new VoiceCallError('The response could not be prepared for speech.', {
                code: 'EMPTY_SPOKEN_RESPONSE',
                status: 502,
            });
        }

        progress('tts.started');
        const speechStartedAt = this.now();
        const synthesized = await this.textToSpeech.synthesize({text: spokenText, call, signal});
        timings.speechMs = elapsed(this.now(), speechStartedAt);
        progress('tts.completed', {durationMs: timings.speechMs, audioBytes: synthesized?.bytes?.length ?? 0});

        if (!synthesized?.bytes || !synthesized.contentType) {
            throw new VoiceCallError('The speech provider returned invalid audio.', {
                code: 'INVALID_SYNTHESIZED_AUDIO',
                status: 502,
            });
        }

        progress('turn.completed', {timings});
        return {
            transcript,
            agentText,
            spokenText,
            audio: {
                bytes: synthesized.bytes,
                contentType: synthesized.contentType,
                filename: synthesized.filename ?? 'agent-reply.mp3',
            },
            timings,
        };
    }

    /**
     * Streams a completed caller utterance into ACP and emits playable sentence
     * audio as soon as the ACP adapter sends text chunks. OpenAI's file
     * transcription endpoint remains a completed-utterance operation; browser
     * VAD is responsible for ending that utterance without a button press.
     */
    async *handleAudioTurnStream({audio, target, call = {}, signal} = {}) {
        validateInput({audio, target});
        const progress = (stage, details = {}) => {
            try {
                this.onProgress({stage, callId: call.id ?? 'unknown', targetId: target.id, ...details});
            } catch {
                // Observability must not change the outcome of a voice turn.
            }
        };

        progress('stt.started', {audioBytes: audio.bytes.length, contentType: audio.contentType});
        const sttStartedAt = this.now();
        const transcript = normalizeText(await this.speechToText.transcribe({audio, locale: call.locale, signal}));
        const transcriptionMs = elapsed(this.now(), sttStartedAt);
        progress('stt.completed', {durationMs: transcriptionMs, transcriptCharacters: transcript.length});
        if (!hasRecognizedSpeech(transcript)) {
            progress('turn.skipped', {reason: 'no_speech'});
            yield {type: 'turn.skipped', reason: 'no_speech'};
            return;
        }
        yield {type: 'transcript.final', transcript};

        progress('acp.connecting');
        const acpStartedAt = this.now();
        const session = await this.acpSessionFactory.open({target, call, signal});
        progress('acp.connected');
        const turnController = new AbortController();
        signal = signal ? AbortSignal.any([signal, turnController.signal]) : turnController.signal;
        const chunks = new AsyncTextQueue();
        let agentText = '';
        let receivedAgentChunks = false;
        const prompt = (async () => {
            try {
                progress('acp.prompting', {transcriptCharacters: transcript.length});
                const promptMethod = session.promptStream ?? session.prompt;
                agentText = normalizeText(await promptMethod.call(session, {
                    text: transcript,
                    call,
                    signal,
                    onText: (chunk) => {
                        receivedAgentChunks = true;
                        chunks.push(chunk);
                    },
                }));
                chunks.close();
            } catch (error) {
                chunks.fail(error);
            } finally {
                try { await session.close?.(); } catch (error) { chunks.fail(error); }
            }
        })();

        try {
            let pendingSpeech = '';
            let firstSpeech = true;
            for await (const chunk of chunks) {
                yield {type: 'agent.text.delta', delta: chunk};
                pendingSpeech += chunk;
                for (const sentence of takeSpeakableSentences(pendingSpeech, firstSpeech)) {
                    pendingSpeech = pendingSpeech.slice(sentence.length);
                    firstSpeech = false;
                    yield* this.#synthesizeStreamChunk({text: sentence, call, signal, progress});
                }
            }
            await prompt;
            if (!agentText) {
                throw new VoiceCallError('The ACP agent completed without a text response.', {
                    code: 'ACP_EMPTY_RESPONSE', status: 502,
                });
            }
            if (!receivedAgentChunks) pendingSpeech = agentText;
            if (pendingSpeech.trim()) {
                yield* this.#synthesizeStreamChunk({text: pendingSpeech, call, signal, progress});
            }
            const timings = {transcriptionMs, agentMs: elapsed(this.now(), acpStartedAt)};
            progress('acp.completed', {durationMs: timings.agentMs, responseCharacters: agentText.length});
            progress('turn.completed', {timings});
            yield {type: 'turn.completed', transcript, agentText, timings};
        } finally {
            turnController.abort();
            await prompt;
        }
    }

    async *#synthesizeStreamChunk({text, call, signal, progress}) {
        const speakableText = text.trim();
        if (!speakableText) return;
        progress('tts.chunk.started', {characters: speakableText.length});
        const startedAt = this.now();
        if (this.textToSpeech.synthesizeStream) {
            let audioBytes = 0;
            for await (const audio of this.textToSpeech.synthesizeStream({text: speakableText, call, signal})) {
                if (!audio?.bytes?.length || !audio.contentType) {
                    throw new VoiceCallError('The speech provider returned invalid audio.', {
                        code: 'INVALID_SYNTHESIZED_AUDIO', status: 502,
                    });
                }
                if (!audioBytes) progress('tts.first_audio', {durationMs: elapsed(this.now(), startedAt)});
                audioBytes += audio.bytes.length;
                yield {type: 'tts.audio', text: audioBytes === audio.bytes.length ? speakableText : '',
                    contentType: audio.contentType, encoding: audio.encoding, sampleRate: audio.sampleRate,
                    audioBase64: audio.bytes.toString('base64')};
            }
            if (!audioBytes) throw new VoiceCallError('The speech provider returned no audio.', {
                code: 'INVALID_SYNTHESIZED_AUDIO', status: 502,
            });
            progress('tts.chunk.completed', {durationMs: elapsed(this.now(), startedAt), audioBytes});
            return;
        }
        const audio = await this.textToSpeech.synthesize({text: speakableText, call, signal});
        if (!audio?.bytes || !audio.contentType) {
            throw new VoiceCallError('The speech provider returned invalid audio.', {
                code: 'INVALID_SYNTHESIZED_AUDIO', status: 502,
            });
        }
        progress('tts.chunk.completed', {durationMs: elapsed(this.now(), startedAt), audioBytes: audio.bytes.length});
        yield {
            type: 'tts.audio',
            text: speakableText,
            contentType: audio.contentType,
            audioBase64: audio.bytes.toString('base64'),
        };
    }
}

function validateInput({audio, target}) {
    if (!audio?.bytes || !Buffer.isBuffer(audio.bytes) || audio.bytes.length === 0) {
        throw new ValidationError('A non-empty audio buffer is required.');
    }
    if (!audio.filename || !audio.contentType) {
        throw new ValidationError('Audio filename and content type are required.');
    }
    if (!target?.id) throw new ValidationError('An ACP target id is required.');
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function hasRecognizedSpeech(text) {
    return /[\p{L}\p{N}]/u.test(text)
        && !/^\s*\[(?:silence|noise|background noise|music|тишина|шум|музыка)\]\s*$/iu.test(text);
}

function elapsed(now, startedAt) {
    return Math.max(0, Math.round(now - startedAt));
}

function takeSpeakableSentences(text, firstSpeech = false) {
    const match = text.match(/^(.*?[.!?](?:[\s\n]+|$))/);
    // Begin a long opening sentence at a natural clause boundary. Keep short
    // greetings and the rest of the response together for consistent prosody.
    if (firstSpeech) {
        const opening = text.split(/[.!?]/, 1)[0];
        for (const boundary of opening.matchAll(/[,;:]\s+/g)) {
            const clause = text.slice(0, boundary.index + boundary[0].length);
            if (clause.trim().length >= 40) return [clause];
        }
    }
    if (match?.[1].trim()) return [match[1]];
    if (text.length >= 280) {
        const boundary = Math.max(text.lastIndexOf(' ', 240), 1);
        return [text.slice(0, boundary + 1)];
    }
    return [];
}

class AsyncTextQueue {
    #values = [];
    #waiter;
    #error;
    #closed = false;

    push(value) {
        if (!value || this.#closed) return;
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (waiter) waiter({value, done: false});
        else this.#values.push(value);
    }

    close() {
        this.#closed = true;
        this.#flush();
    }

    fail(error) {
        this.#error = error;
        this.#closed = true;
        this.#flush();
    }

    #flush() {
        const waiter = this.#waiter;
        this.#waiter = undefined;
        if (!waiter) return;
        if (this.#error) waiter(Promise.reject(this.#error));
        else waiter({value: undefined, done: true});
    }

    async next() {
        if (this.#values.length) return {value: this.#values.shift(), done: false};
        if (this.#error) throw this.#error;
        if (this.#closed) return {value: undefined, done: true};
        return new Promise((resolve) => { this.#waiter = resolve; });
    }

    [Symbol.asyncIterator]() { return this; }
}
