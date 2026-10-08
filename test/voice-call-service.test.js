import assert from 'node:assert/strict';
import test from 'node:test';

import {createOpenAiReplyPresenter, createOpenAiSpeechAdapters, ValidationError, VoiceCallService} from '../src/index.js';

function service(overrides = {}) {
    return new VoiceCallService({
        speechToText: {transcribe: async () => '  schedule a reminder  '},
        acpSessionFactory: {
            open: async () => ({
                prompt: async ({text}) => `Agent received: ${text}`,
                close: async () => {
                },
            }),
        },
        replyPresenter: {present: async ({agentText}) => `Spoken: ${agentText}`},
        textToSpeech: {synthesize: async () => ({bytes: Buffer.from('audio'), contentType: 'audio/mpeg'})},
        ...overrides,
    });
}

const audio = {bytes: Buffer.from('input'), filename: 'turn.webm', contentType: 'audio/webm'};

test('speech adapters require the configured gateway instead of using a default endpoint', () => {
    assert.throws(() => createOpenAiSpeechAdapters({apiKey: 'test-key'}), /gateway baseURL is required/);
});

test('transcription requests use the configured gateway and existing API key', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({url: String(url), authorization: new Headers(options.headers).get('Authorization')});
        return new Response(JSON.stringify({text: 'Preview text'}), {headers: {'Content-Type': 'application/json'}});
    };
    try {
        const adapters = createOpenAiSpeechAdapters({apiKey: 'gateway-key', baseURL: 'https://configured-gateway.example/v1'});
        assert.equal(await adapters.speechToText.transcribe({audio}), 'Preview text');
        assert.deepEqual(requests, [{url: 'https://configured-gateway.example/v1/audio/transcriptions', authorization: 'Bearer gateway-key'}]);
    } finally {globalThis.fetch = originalFetch;}
});

test('speech streaming delivers first samples before completion and preserves split PCM samples', async () => {
    const originalFetch = globalThis.fetch;
    let streamController;
    const expected = Buffer.from(Array.from({length: 9600}, (_, i) => i % 256));
    globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://configured-gateway.example/v1/audio/speech');
        assert.equal(JSON.parse(options.body).response_format, 'pcm');
        return new Response(new ReadableStream({start(controller) {
            streamController = controller;
            controller.enqueue(expected.subarray(0, 4801));
        }}));
    };
    let stream;
    try {
        const adapters = createOpenAiSpeechAdapters({apiKey: 'gateway-key', baseURL: 'https://configured-gateway.example/v1'});
        stream = adapters.textToSpeech.synthesizeStream({text: 'Hello.'});
        const first = await stream.next();
        assert.equal(first.value.sampleRate, 24000);
        assert.equal(first.value.encoding, 'pcm_s16le');
        assert.equal(first.value.bytes.length, 4800);
        streamController.enqueue(expected.subarray(4801));
        streamController.close();
        const second = await stream.next();
        assert.deepEqual(Buffer.concat([first.value.bytes, second.value.bytes]), expected);
        assert.equal((await stream.next()).done, true);
    } finally {
        await stream?.return();
        globalThis.fetch = originalFetch;
    }
});

test('voice stream forwards audio before synthesis completes', async () => {
    let release;
    let synthesisCompleted = false;
    const gate = new Promise(resolve => {release = resolve;});
    const voiceCallService = service({
        textToSpeech: {
            synthesize: async () => {throw new Error('Buffered synthesis should not be used');},
            async *synthesizeStream() {
                yield {bytes: Buffer.from([0, 1]), contentType: 'audio/pcm', encoding: 'pcm_s16le', sampleRate: 24000};
                await gate;
                synthesisCompleted = true;
                yield {bytes: Buffer.from([2, 3]), contentType: 'audio/pcm', encoding: 'pcm_s16le', sampleRate: 24000};
            },
        },
    });
    const events = [];
    for await (const event of voiceCallService.handleAudioTurnStream({audio, target: {id: 'agent'}})) {
        events.push(event);
        if (event.type === 'tts.audio' && !synthesisCompleted) release();
    }
    assert.equal(events.filter(event => event.type === 'tts.audio').length, 2);
    assert.equal(events.at(-1).type, 'turn.completed');
});

test('runs STT, ACP, presentation, and TTS in order', async () => {
    const result = await service().handleAudioTurn({audio, target: {id: 'local-agent'}});

    assert.equal(result.transcript, 'schedule a reminder');
    assert.equal(result.agentText, 'Agent received: schedule a reminder');
    assert.equal(result.spokenText, 'Spoken: Agent received: schedule a reminder');
    assert.deepEqual(result.audio, {
        bytes: Buffer.from('audio'),
        contentType: 'audio/mpeg',
        filename: 'agent-reply.mp3',
    });
});

test('rejects an empty transcription before opening ACP', async () => {
    let acpOpened = false;
    const voiceCallService = service({
        speechToText: {transcribe: async () => ' '},
        acpSessionFactory: {
            open: async () => {
                acpOpened = true;
            }
        },
    });

    await assert.rejects(
        voiceCallService.handleAudioTurn({audio, target: {id: 'local-agent'}}),
        ValidationError,
    );
    assert.equal(acpOpened, false);
});

test('closes ACP sessions when prompting fails', async () => {
    let closed = false;
    const voiceCallService = service({
        acpSessionFactory: {
            open: async () => ({
                prompt: async () => {
                    throw new Error('agent unavailable');
                },
                close: async () => {
                    closed = true;
                },
            }),
        },
    });

    await assert.rejects(voiceCallService.handleAudioTurn({audio, target: {id: 'local-agent'}}));
    assert.equal(closed, true);
});

test('passes OpenAI abort signals as SDK request options instead of API payload fields', async () => {
    const controller = new AbortController();
    let receivedBody;
    let receivedOptions;
    const presenter = createOpenAiReplyPresenter({
        client: {
            responses: {
                create: async (body, options) => {
                    receivedBody = body;
                    receivedOptions = options;
                    return {output_text: 'Ready.'};
                },
            },
        },
    });

    const spokenText = await presenter.present({
        agentText: 'The agent is ready.',
        maxCharacters: 100,
        signal: controller.signal,
    });

    assert.equal(spokenText, 'Ready.');
    assert.equal(receivedBody.signal, undefined);
    assert.deepEqual(receivedOptions, {signal: controller.signal});
});

test('streams ACP text and sentence audio before the ACP turn completes', async () => {
    const events = [];
    let releaseFinal;
    const finalGate = new Promise((resolve) => { releaseFinal = resolve; });
    const voiceCallService = service({
        acpSessionFactory: {
            open: async () => ({
                promptStream: async ({onText}) => {
                    onText('First sentence. ');
                    await finalGate;
                    onText('Second sentence.');
                    return 'First sentence. Second sentence.';
                },
                close: async () => {},
            }),
        },
        textToSpeech: {
            synthesize: async ({text}) => ({bytes: Buffer.from(`audio:${text}`), contentType: 'audio/mpeg'}),
        },
    });

    const stream = voiceCallService.handleAudioTurnStream({audio, target: {id: 'local-agent'}});
    for await (const event of stream) {
        events.push(event);
        if (event.type === 'tts.audio') releaseFinal();
    }

    assert.deepEqual(events.map(({type}) => type), [
        'transcript.final',
        'agent.text.delta',
        'tts.audio',
        'agent.text.delta',
        'tts.audio',
        'turn.completed',
    ]);
    assert.equal(events[2].text, 'First sentence.');
    assert.equal(events.at(-1).agentText, 'First sentence. Second sentence.');
});

test('starts speech at an opening clause before the agent finishes its first sentence', async () => {
    const opening = 'Да, я проверила очередь воспроизведения аудио, ';
    const remainder = 'теперь фрагменты звучат непрерывно.';
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const spoken = [];
    const voiceCallService = service({
        acpSessionFactory: {open: async () => ({
            async promptStream({onText}) {
                onText('Да, ');
                onText(opening.slice(4));
                await gate;
                onText(remainder);
                return opening + remainder;
            },
            async close() {},
        })},
        textToSpeech: {async synthesize({text}) {
            spoken.push(text);
            return {bytes: Buffer.from('audio'), contentType: 'audio/mpeg'};
        }},
    });
    const stream = voiceCallService.handleAudioTurnStream({audio, target: {id: 'local-agent'}});
    const events = [];
    for await (const event of stream) {
        events.push(event);
        if (event.type === 'tts.audio') release();
    }
    assert.deepEqual(spoken, [opening.trim(), remainder]);
    assert.equal(events.findIndex(event => event.type === 'tts.audio'), 3);
    assert.equal(events.at(-1).agentText, opening + remainder);
});

 test('streams a complete response from non-streaming ACP adapters as one TTS chunk', async () => {
    const events = [];
    const voiceCallService = service({
        acpSessionFactory: {
            open: async () => ({prompt: async () => 'A complete ACP response.', close: async () => {}}),
        },
    });

    for await (const event of voiceCallService.handleAudioTurnStream({audio, target: {id: 'local-agent'}})) {
        events.push(event);
    }

    assert.equal(events.find(({type}) => type === 'tts.audio').text, 'A complete ACP response.');
});
