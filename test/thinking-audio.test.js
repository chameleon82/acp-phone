import assert from 'node:assert/strict';
import test from 'node:test';
import {createThinkingAudio} from '../examples/web/thinking-audio.js';

test('waiting audio generates a fresh contextual phrase before synthesis', async () => {
    const inputs = [];
    const spoken = [];
    const getAudio = createThinkingAudio({
        async present(input) {inputs.push(input); return `Думаю над вопросом ${inputs.length}.`;},
        async synthesize({text}) {spoken.push(text); return {bytes: Buffer.from(text), contentType: 'audio/mpeg'};},
    });
    const context = {transcript: 'Проверь задержку', draft: '', previous: 'Секунду', language: 'ru'};
    const first = await getAudio(context);
    const second = await getAudio(context);
    assert.notEqual(first.text, second.text);
    assert.equal(inputs[0].transcript, context.transcript);
    assert.equal(inputs[0].previous, context.previous);
    assert.deepEqual(spoken, [first.text, second.text]);
});

test('cancellation after phrase generation prevents synthesis', async () => {
    const controller = new AbortController();
    const getAudio = createThinkingAudio({
        async present() {controller.abort(); return 'Думаю.';},
        async synthesize() {assert.fail('Cancelled cue must not synthesize');},
    });
    await assert.rejects(getAudio({signal: controller.signal}), {name: 'AbortError'});
});

test('excessive generated phrases are discarded', async () => {
    for (const text of ['x'.repeat(181)]) {
        const getAudio = createThinkingAudio({
            async present() {return text;},
            async synthesize() {assert.fail('Invalid cue must not synthesize');},
        });
        await assert.rejects(getAudio({}), /Invalid waiting acknowledgement/);
    }
});

test('a model decision to omit a cue does not synthesize or send audio', async () => {
    const getAudio = createThinkingAudio({
        async present({transcript}) {assert.equal(transcript, 'Привет'); return '';},
        async synthesize() {assert.fail('An omitted cue must not synthesize');},
        async *synthesizeStream() {assert.fail('An omitted cue must not synthesize');},
    });
    assert.equal(await getAudio({transcript: 'Привет', onAudio() {assert.fail('No cue audio expected');}}), undefined);
});

test('waiting audio forwards the first PCM packet before synthesis completes', async () => {
    const received = [];
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const getAudio = createThinkingAudio({
        async present() {return 'Секунду, подумаю над этим.';},
        async *synthesizeStream({speed}) {
            assert.equal(speed, 1.1);
            yield {bytes: Buffer.alloc(4800), contentType: 'audio/pcm', encoding: 'pcm_s16le', sampleRate: 24000};
            await gate;
            yield {bytes: Buffer.alloc(4800), contentType: 'audio/pcm', encoding: 'pcm_s16le', sampleRate: 24000};
        },
    });
    await getAudio({onAudio(packet) {received.push(packet); release();}});
    assert.equal(received.length, 2);
    assert.equal(received[0].text, 'Секунду, подумаю над этим.');
    assert.equal(received[1].text, '');
});
