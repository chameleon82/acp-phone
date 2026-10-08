import assert from 'node:assert/strict';
import test from 'node:test';

import {createOpenAiReplyPresenter, ValidationError, VoiceCallService} from '../src/index.js';

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