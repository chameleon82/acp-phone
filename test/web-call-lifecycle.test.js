import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../examples/web/public/app.js', import.meta.url), 'utf8'))
    .replace('await loadTargets();', '');

function browser(overrides = {}) {
    const elements = new Map();
    const timeouts = new Map();
    let timeoutId = 0;
    const element = () => ({
        textContent: '—', classList: {add() {}, remove() {}, toggle() {}},
        setAttribute() {}, addEventListener() {}, disabled: false,
    });
    const context = vm.createContext({
        document: {querySelector: (selector) => {
            if (!elements.has(selector)) elements.set(selector, element());
            return elements.get(selector);
        }},
        window: {addEventListener() {}, MediaRecorder: class {}},
        navigator: {mediaDevices: {getUserMedia: async () => {throw new Error('Permission denied');}}},
        localStorage: {getItem: () => null, setItem() {}},
        crypto: {randomUUID: () => 'call-id'},
        setInterval: () => 1, clearInterval() {}, cancelAnimationFrame() {},
        setTimeout: (callback, delay) => {
            timeouts.set(++timeoutId, {callback, delay});
            return timeoutId;
        },
        clearTimeout: (id) => timeouts.delete(id),
        AudioContext: class {async resume() {} async close() {}},
        fetch: async () => ({ok: true}),
        AbortController, AbortSignal, Blob, FormData, Uint8Array, atob, TextDecoderStream,
        URL: {createObjectURL: () => 'blob:audio', revokeObjectURL() {}},
        Audio: class {
            addEventListener() {}
            async play() {}
            pause() {}
        },
        ...overrides,
    });
    vm.runInContext(source, context);
    return {context, elements, timeouts, run: (code) => vm.runInContext(code, context),
        async retry() {
            const [id, {callback}] = timeouts.entries().next().value;
            timeouts.delete(id);
            await callback();
        },
    };
}

test('microphone denial resets controls and permits another call', async () => {
    const page = browser();
    await page.run('startCall()');
    assert.equal(page.run('state'), 'ready');
    assert.equal(page.elements.get('#call').disabled, false);
    assert.equal(page.elements.get('#mute').disabled, true);
    assert.match(page.elements.get('#status').textContent, /Permission denied/);
});

test('ending a call while microphone permission is pending releases the late stream', async () => {
    let grant;
    let permissionRequested;
    const pendingPermission = new Promise((resolve) => {permissionRequested = resolve;});
    let stopped = false;
    const page = browser({navigator: {mediaDevices: {getUserMedia: () => new Promise((resolve) => {
        grant = resolve;
        permissionRequested();
    })}}});
    const starting = page.run('startCall()');
    await pendingPermission;
    page.run('endCall()');
    grant({getTracks: () => [{stop() {stopped = true;}}]});
    await starting;
    assert.equal(stopped, true);
    assert.equal(page.run('state'), 'ready');
});

test('interrupting playback settles the old queue and allows a new reply', async () => {
    const page = browser();
    page.run("state = 'playing'; audioQueue.push({audioBase64: 'YQ==', contentType: 'audio/mpeg'});");
    const first = page.run('playAudioQueue()');
    page.run('cancelAgentReply()');
    await first;
    assert.equal(page.run('playingQueue'), false);
    page.run("audioQueue.push({audioBase64: 'Yg==', contentType: 'audio/mpeg'});");
    const second = page.run('playAudioQueue()');
    assert.equal(page.run('playingQueue'), true);
    page.run('stopPlayback()');
    await second;
    assert.equal(page.run('playingQueue'), false);
});

test('enabling the speaker resumes paused audio and advances the reply queue', async () => {
    const clips = [];
    const page = browser({Audio: class {
        constructor() {
            this.listeners = new Map();
            this.plays = 0;
            clips.push(this);
        }
        addEventListener(type, listener) {this.listeners.set(type, listener);}
        async play() {this.paused = false; this.plays++;}
        pause() {this.paused = true;}
        set muted(value) {
            this.isMuted = value;
            if (!value && this.plays) this.pause();
        }
    }});
    page.run("state = 'playing'; audioQueue.push({audioBase64: 'YQ=='}, {audioBase64: 'Yg=='});");
    const playback = page.run('playAudioQueue()');
    page.run('toggleSpeaker(); toggleSpeaker();');
    assert.equal(clips[0].isMuted, false);
    assert.equal(clips[0].paused, false);
    assert.equal(clips[0].plays, 2);
    clips[0].listeners.get('ended')();
    await Promise.resolve();
    assert.equal(clips.length, 2);
    assert.equal(clips[1].isMuted, false);
    clips[1].listeners.get('ended')();
    await playback;
    assert.equal(page.run('playingQueue'), false);
});

test('a failed speaker resume releases the queue so another reply can play', async () => {
    const page = browser();
    page.run("state = 'playing'; audioQueue.push({audioBase64: 'YQ=='});");
    const playback = page.run('playAudioQueue()');
    page.run("toggleSpeaker(); currentAudio.play = () => Promise.reject(new Error('Playback blocked')); toggleSpeaker();");
    await playback;
    assert.equal(page.run('playingQueue'), false);
    assert.equal(page.run('currentAudio'), undefined);
    assert.match(page.elements.get('#status').textContent, /Playback blocked/);
    page.run("audioQueue.push({audioBase64: 'Yg=='});");
    const next = page.run('playAudioQueue()');
    page.run('stopPlayback()');
    await next;
    assert.equal(page.run('playingQueue'), false);
});


test('redial and browser restart reuse the stored conversation for the selected target', async () => {
    const values = new Map();
    const localStorage = {getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)};
    let generated = 0;
    const overrides = {localStorage, crypto: {randomUUID: () => `call-${++generated}`}};
    const page = browser(overrides);
    page.elements.get('#target').value = 'agent-a';
    await page.run('startCall()');
    await page.run('startCall()');
    assert.equal(generated, 1);
    const restarted = browser(overrides);
    restarted.elements.get('#target').value = 'agent-a';
    await restarted.run('startCall()');
    assert.equal(generated, 1);
    restarted.elements.get('#target').value = 'agent-b';
    await restarted.run('startCall()');
    assert.equal(generated, 2);
});

test('pagehide cleanup preserves the server session', () => {
    let requests = 0;
    const page = browser({fetch: async () => { requests++; return {}; }});
    page.run("callId = 'existing'; endCall({release: false});");
    assert.equal(requests, 0);
    assert.equal(page.run('callId'), undefined);
});


test('a truncated reply reports disconnection and keeps the conversation ID', async () => {
    const page = browser();
    page.run("callId = 'recoverable';");
    const stream = new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"transcript.final","transcript":"hello"}\n'));
        controller.close();
    }});
    page.context.replyStream = stream;
    await assert.rejects(page.run('consumeStream(replyStream, new AbortController().signal)'), /Connection interrupted/);
    assert.equal(page.run('callId'), 'recoverable');
});

test('connection failure retries the same conversation before opening the microphone', async () => {
    const requests = [];
    let offline = true;
    const page = browser({fetch: async (url) => {
        requests.push(url);
        if (offline) throw new TypeError('Network error');
        return {ok: true};
    }});
    page.elements.get('#target').value = 'agent-a';
    await page.run('startCall()');
    assert.equal(page.run('state'), 'ready');
    assert.match(page.elements.get('#status').textContent, /Connection unavailable/);
    offline = false;
    await page.run('startCall()');
    assert.deepEqual(requests, ['/api/calls/agent-a/call-id/resume', '/api/calls/agent-a/call-id/resume']);
    assert.match(page.elements.get('#status').textContent, /Microphone unavailable/);
});

test('browser restart restores the selected agent', async () => {
    const page = browser({
        localStorage: {getItem: (key) => key === 'acp-phone.target' ? 'agent-b' : null, setItem() {}},
        Option: class {},
        fetch: async () => ({ok: true, json: async () => ({targets: [
            {id: 'agent-a', label: 'A'}, {id: 'agent-b', label: 'B'},
        ]})}),
    });
    const target = page.elements.get('#target');
    target.add = () => {};
    target.selectedOptions = [{textContent: 'B'}];
    await page.run('loadTargets()');
    assert.equal(target.value, 'agent-b');
    assert.equal(page.run('state'), 'ready');
});

test('a network error automatically restores the same conversation before the next turn', async () => {
    const callIds = [];
    const resumes = [];
    const page = browser({
        navigator: {language: 'ru-RU'},
        fetch: async (url, {body}) => {
            if (url.endsWith('/resume')) {
                resumes.push(url);
                return {ok: true};
            }
            callIds.push(body.get('callId'));
            if (callIds.length === 1) throw new TypeError('Network error');
            return {ok: true, body: new ReadableStream({start(controller) {
                controller.enqueue(new TextEncoder().encode('{"type":"turn.completed","agentText":"continued"}\n'));
                controller.close();
            }})};
        },
    });
    page.run("state = 'connected'; callId = 'existing-conversation';");
    await page.run("sendUtterance(['voice'], 'audio/webm')");
    assert.equal(page.run('state'), 'reconnecting');
    await page.retry();
    assert.equal(page.run('state'), 'connected');
    assert.deepEqual(resumes, ['/api/calls/undefined/existing-conversation/resume']);
    await page.run("sendUtterance(['next voice'], 'audio/webm')");
    assert.deepEqual(callIds, ['existing-conversation', 'existing-conversation']);
    assert.equal(page.elements.get('#agent-text').textContent, 'continued');
});

test('reconnect keeps retrying while the server is down and clears the error when it returns', async () => {
    let attempts = 0;
    const page = browser({fetch: async () => {
        if (++attempts < 3) throw new TypeError('Network error');
        return {ok: true};
    }});
    page.run("state = 'connected'; callId = 'saved'; beginReconnect();");
    await page.retry();
    assert.equal(page.run('state'), 'reconnecting');
    await page.retry();
    assert.equal(page.run('state'), 'reconnecting');
    await page.retry();
    assert.equal(page.run('state'), 'connected');
    assert.equal(page.run('callId'), 'saved');
    assert.equal(page.timeouts.size, 0);
    assert.match(page.elements.get('#status').textContent, /Connected/);
});

test('hangup cancels retries and ignores a late successful reconnect', async () => {
    let resolveResponse;
    const page = browser({fetch: () => new Promise((resolve) => {resolveResponse = resolve;})});
    page.run("state = 'connected'; callId = 'saved'; beginReconnect();");
    const retry = page.retry();
    page.run('endCall({release: false})');
    resolveResponse({ok: true});
    await retry;
    assert.equal(page.run('state'), 'ready');
    assert.equal(page.timeouts.size, 0);
    assert.equal(page.run('recoveryRequest'), undefined);
});

test('idle call detects server loss and reconnects without a voice turn', async () => {
    const page = browser({fetch: async (url) => {
        if (url === '/api/health') throw new TypeError('Network error');
        return {ok: true};
    }});
    page.run("state = 'connected'; callId = 'saved';");
    await page.run('checkConnection()');
    assert.equal(page.run('state'), 'reconnecting');
    await page.retry();
    assert.equal(page.run('state'), 'connected');
});

test('a quick server restart reloads the session even if health requests succeed', async () => {
    const page = browser({fetch: async () => ({ok: true, json: async () => ({instanceId: 'new-server'})})});
    page.run("state = 'connected'; callId = 'saved'; serverInstanceId = 'old-server'; muted = true;");
    await page.run('checkConnection()');
    assert.equal(page.run('state'), 'reconnecting');
    await page.retry();
    assert.equal(page.run('state'), 'connected');
    assert.equal(page.run('muted'), true);
    assert.match(page.elements.get('#status').textContent, /Microphone muted/);
});

test('application errors do not automatically resubmit a voice turn', async () => {
    const page = browser({navigator: {language: 'ru'}, fetch: async () => ({
        ok: false, status: 400, json: async () => ({error: {message: 'No speech recognized'}}),
    })});
    page.run("state = 'connected'; callId = 'saved';");
    await page.run("sendUtterance(['voice'], 'audio/webm')");
    assert.equal(page.run('state'), 'connected');
    assert.equal(page.timeouts.size, 0);
    assert.match(page.elements.get('#status').textContent, /No speech recognized/);
});

test('long speech updates call notes through preview uploads and merges overlapping words', async () => {
    let uploads = 0;
    const page = browser({fetch: async (url, {body}) => {
        assert.equal(url, '/api/calls/agent-a/transcription');
        const file = body.get('audio');
        assert.equal(file.type, 'audio/wav');
        const view = new DataView(await file.arrayBuffer());
        assert.equal(view.getUint32(24, true), 16000);
        assert.equal(view.getUint32(40, true), 4 * 16000 * 2);
        return {ok: true, json: async () => ({transcript: ++uploads === 1 ? 'Hello world' : 'world, keep speaking'})};
    }});
    page.context.inputSamples = new Float32Array(16000 * 4);
    page.elements.get('#target').value = 'agent-a';
    page.run(`
        state = 'recording'; transcriptGeneration = 1;
        const preview = {samples: inputSamples, sampleRate: 16000, token: 1, text: ''};
        liveTranscription = preview;
    `);
    await page.run('updateLivePreview(preview)');
    assert.equal(page.elements.get('#transcript').textContent, 'Hello world');
    page.run('preview.samples = inputSamples;');
    await page.run('updateLivePreview(preview)');
    assert.equal(page.elements.get('#transcript').textContent, 'Hello world keep speaking');
    assert.equal(uploads, 2);
});

test('late preview responses cannot overwrite final text or the next utterance', async () => {
    let respond;
    const page = browser({fetch: () => new Promise(resolve => {respond = resolve;})});
    page.context.inputSamples = new Float32Array(16000 * 4);
    page.run(`
        transcriptGeneration = 1;
        const preview = {samples: inputSamples, sampleRate: 16000, token: 1, text: ''};
        liveTranscription = preview;
    `);
    const pending = page.run('updateLivePreview(preview)');
    page.run(`
        resetLivePreview();
        handleStreamEvent({type: 'transcript.final', transcript: 'Final text.'});
    `);
    respond({ok: true, json: async () => ({transcript: 'Late preview'})});
    await pending;
    assert.equal(page.elements.get('#transcript').textContent, 'Final text.');
});

test('muting cancels a preview upload and clears buffered speech', () => {
    const page = browser();
    page.run(`
        state = 'recording';
        const previewRequest = new AbortController();
        liveTranscription = {token: 1, request: previewRequest, samples: new Float32Array(100), text: 'old'};
        toggleMicrophone();
    `);
    assert.equal(page.run('previewRequest.signal.aborted'), true);
    assert.equal(page.run('liveTranscription.samples.length'), 0);
    assert.equal(page.run('liveTranscription.token'), undefined);
});

test('preview WAV preserves sample rate, length and signed sample values', async () => {
    const page = browser();
    const blob = page.run('encodePreviewWav(new Float32Array([-2, -1, 0, 1, 2]), 48000)');
    const view = new DataView(await blob.arrayBuffer());
    assert.equal(view.byteLength, 54);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint16(34, true), 16);
    assert.deepEqual(Array.from({length: 5}, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767]);
});

test('microphone capture preserves samples across audio processing block boundaries', async () => {
    const chunks = [];
    let Capture;
    const context = vm.createContext({
        AudioWorkletProcessor: class {port = {postMessage(samples) {chunks.push([...samples]);}};},
        registerProcessor(name, processor) {assert.equal(name, 'pcm-capture'); Capture = processor;},
    });
    vm.runInContext(await readFile(new URL('../examples/web/public/pcm-capture.js', import.meta.url), 'utf8'), context);
    const capture = new Capture();
    for (let index = 0; index < 65; index++) {
        const samples = Float32Array.from({length: 128}, (_, i) => index * 128 + i);
        assert.equal(capture.process([[samples]]), true);
    }
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.flat(), Array.from({length: 8192}, (_, i) => i));
});

test('streamed PCM plays directly without waiting for a complete encoded audio file', async () => {
    let samples;
    let started = 0;
    let stopped = 0;
    const source = {connect: () => ({connect() {}}), addEventListener() {},
        start() {started++;}, stop() {stopped++;}, disconnect() {}};
    const audioContext = {
        createBuffer(channels, length, rate) {
            assert.equal(channels, 1); assert.equal(rate, 24000);
            samples = new Float32Array(length);
            return {getChannelData: () => samples};
        },
        createBufferSource: () => source,
        createGain: () => ({gain: {}, disconnect() {}}),
        async resume() {},
        decodeAudioData() {throw new Error('PCM must not use file decoding');},
    };
    const page = browser();
    page.context.pcmContext = audioContext;
    const bytes = Buffer.alloc(6);
    bytes.writeInt16LE(-32768, 0); bytes.writeInt16LE(0, 2); bytes.writeInt16LE(32767, 4);
    page.context.pcmEvent = {encoding: 'pcm_s16le', sampleRate: 24000, audioBase64: bytes.toString('base64')};
    const playback = await page.run('createVoicePlayback(pcmEvent, pcmContext)');
    assert.deepEqual([...samples], [-1, 0, 32767 / 32768]);
    await playback.play();
    assert.equal(started, 1);
    playback.pause();
    assert.equal(stopped, 1);
});

test('PCM packets are scheduled contiguously before playback ends and all stop on interruption', async () => {
    const sources = [];
    const context = {
        currentTime: 10,
        createBuffer(channels, length) {return {getChannelData: () => new Float32Array(length)};},
        createBufferSource() {
            const source = {connect: () => ({connect() {}}), disconnect() {},
                addEventListener(type, listener) {this.ended = listener;},
                start(time) {this.startTime = time;}, stop() {this.stopped = true;}};
            sources.push(source);
            return source;
        },
        createGain: () => ({gain: {}, disconnect() {}}),
        async resume() {},
    };
    const page = browser();
    page.context.scheduledContext = context;
    page.context.packet = {encoding: 'pcm_s16le', sampleRate: 24000, audioBase64: Buffer.alloc(4800).toString('base64')};
    page.run("audioContext = scheduledContext; state = 'playing';");
    await page.run('enqueuePcmAudio(packet)');
    assert.equal(sources[0].startTime, undefined);
    // A delayed second packet must not leave the first one playing alone.
    context.currentTime = 10.5;
    await page.run('enqueuePcmAudio(packet)');
    assert.ok(sources.every(source => source.startTime === undefined));
    await page.run('enqueuePcmAudio(packet)');
    assert.ok(sources.every(source => source.startTime === undefined));
    assert.equal(page.timeouts.size, 0);
    await page.run('enqueuePcmAudio(packet)');
    await page.run('enqueuePcmAudio(packet)');
    assert.equal(sources.length, 5);
    assert.ok(Math.abs(sources[0].startTime - 10.53) < 1e-9);
    assert.ok(Math.abs(sources[1].startTime - 10.63) < 1e-9);
    assert.ok(Math.abs(sources[2].startTime - 10.73) < 1e-9);
    sources[0].ended();
    assert.equal(page.run('playingQueue'), true);
    page.run('cancelAgentReply()');
    assert.ok(sources.every(source => source.stopped));
    sources[1].ended();
    assert.equal(page.run('pcmPlayback'), undefined);
    assert.equal(page.run('playingQueue'), false);
    // A reply shorter than the startup buffer still plays at stream completion.
    await page.run('enqueuePcmAudio(packet)');
    assert.equal(sources[5].startTime, undefined);
    page.run("handleStreamEvent({type: 'turn.completed', agentText: 'Short reply.'})");
    await page.run('pcmPlayback.flush()');
    assert.equal(typeof sources[5].startTime, 'number');
    page.run('cancelAgentReply()');
});

test('waiting cue starts only after a delay and stops immediately for the actual reply', async () => {
    const cue = {plays: 0, stops: 0, addEventListener() {}, async play() {this.plays++;}, pause() {this.stops++;}};
    const page = browser({fetch: async () => new Response(JSON.stringify({audioBase64: 'AAA=', sampleRate: 24000}) + '\n')});
    page.context.cue = cue;
    page.run("state = 'thinking'; audioContext = {currentTime: 0, async resume() {}}; createVoicePlayback = async () => cue; startThinkingNotice();");
    assert.equal(cue.plays, 0);
    assert.equal([...page.timeouts.values()][0].delay, 2000);
    await page.retry();
    assert.equal(cue.plays, 1);
    page.run("enqueueAudio = () => {}; handleStreamEvent({type: 'tts.audio'});");
    assert.equal(cue.stops, 1);
    assert.equal(page.run('thinkingAudio'), undefined);
});

test('a noise-only recording ends normally and returns to listening without a waiting cue', async () => {
    const page = browser();
    page.run("state = 'thinking'; startThinkingNotice();");
    page.context.noiseStream = new Response(JSON.stringify({type: 'turn.skipped', reason: 'no_speech'}) + '\n').body;
    await page.run('consumeStream(noiseStream, new AbortController().signal)');
    assert.equal(page.run('state'), 'connected');
    assert.equal(page.timeouts.size, 0);
    assert.equal(page.run('transcriptFinalized'), true);
    assert.equal(page.elements.get('#transcript').textContent, '—');
});

test('noise does not abort or pause the agent response already playing', async () => {
    const audio = {pauses: 0, pause() {this.pauses++;}};
    const oldRequest = new AbortController();
    const page = browser({navigator: {language: 'ru-RU'}, fetch: async () => new Response(
        JSON.stringify({type: 'turn.skipped', reason: 'no_speech'}) + '\n')});
    page.context.oldRequest = oldRequest;
    page.context.oldAudio = audio;
    page.run("state = 'thinking'; activeRequest = oldRequest; currentAudio = oldAudio; playingQueue = true; agentText.textContent = 'Previous response';");
    await page.run("sendUtterance(['noise'], 'audio/webm')");
    assert.equal(oldRequest.signal.aborted, false);
    assert.equal(audio.pauses, 0);
    assert.equal(page.run('playingQueue'), true);
    assert.equal(page.run('state'), 'playing');
    assert.equal(page.elements.get('#agent-text').textContent, 'Previous response');
    assert.equal(page.timeouts.size, 0);
});

test('microphone activation alone keeps the agent audio and request running', () => {
    const oldRequest = new AbortController();
    const audio = {pause() {assert.fail('VAD alone must not pause agent audio');}};
    const page = browser({performance: {now: () => 100}, MediaRecorder: class {
        static isTypeSupported() {return true;}
        addEventListener() {}
        start() {this.state = 'recording';}
    }});
    page.context.oldRequest = oldRequest;
    page.context.oldAudio = audio;
    page.run("state = 'playing'; recordingStream = {}; activeRequest = oldRequest; currentAudio = oldAudio; playingQueue = true; beginUtterance();");
    assert.equal(oldRequest.signal.aborted, false);
    assert.equal(page.run('playingQueue'), true);
    assert.equal(page.run('recorder.state'), 'recording');
});

test('first recognized preview words interrupt the agent while recording continues', async () => {
    const previous = new AbortController();
    const audio = {pauses: 0, pause() {this.pauses++;}};
    let uploads = 0;
    const page = browser({fetch: async (url, {body}) => {
        assert.match(url, /\/transcription$/);
        const view = new DataView(await body.get('audio').arrayBuffer());
        assert.equal(view.getUint32(40, true), 0.8 * 16000 * 2);
        uploads++;
        return {ok: true, async json() {return {transcript: 'Я хочу'};}};
    }});
    page.context.previous = previous;
    page.context.oldAudio = audio;
    page.run(`
        state = 'recording'; transcriptGeneration = 1; recorder = {state: 'recording'};
        activeRequest = previous; currentAudio = oldAudio; playingQueue = true;
        const preview = {samples: new Float32Array(12800), sampleRate: 16000, token: 1, text: ''};
        liveTranscription = preview;
    `);
    await page.run('updateLivePreview(preview)');
    assert.equal(previous.signal.aborted, true);
    assert.equal(audio.pauses, 1);
    assert.equal(page.run('recorder.state'), 'recording');
    assert.equal(page.run('state'), 'recording');
    assert.equal(uploads, 1);
});

test('short noise previews keep agent audio running', async () => {
    for (const text of ['', '…', '[noise]']) {
        const previous = new AbortController();
        const page = browser({fetch: async () => ({ok: true, async json() {return {transcript: text};}})});
        page.context.previous = previous;
        page.run(`
            state = 'recording'; transcriptGeneration = 1; activeRequest = previous; playingQueue = true;
            currentAudio = {pause() {throw new Error('Noise must not stop audio');}};
            const preview = {samples: new Float32Array(12800), sampleRate: 16000, token: 1, text: ''};
            liveTranscription = preview;
        `);
        await page.run('updateLivePreview(preview)');
        assert.equal(previous.signal.aborted, false);
        assert.equal(page.run('playingQueue'), true);
    }
});

test('recognized speech interrupts the previous response only when transcription arrives', async () => {
    const audio = {pauses: 0, pause() {this.pauses++;}};
    const oldRequest = new AbortController();
    let controller;
    let requested;
    const started = new Promise(resolve => {requested = resolve;});
    const page = browser({navigator: {language: 'ru-RU'}, fetch: async () => {
        requested();
        return {ok: true, body: new ReadableStream({start(stream) {controller = stream;}})};
    }});
    page.context.oldRequest = oldRequest;
    page.context.oldAudio = audio;
    page.run("state = 'thinking'; activeRequest = oldRequest; currentAudio = oldAudio; playingQueue = true;");
    const sending = page.run("sendUtterance(['speech'], 'audio/webm')");
    await started;
    assert.equal(oldRequest.signal.aborted, false);
    assert.equal(audio.pauses, 0);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({type: 'transcript.final', transcript: 'Да'}) + '\n'
        + JSON.stringify({type: 'turn.completed', agentText: 'New response'}) + '\n'));
    controller.close();
    await sending;
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(audio.pauses, 1);
    assert.equal(page.elements.get('#agent-text').textContent, 'New response');
});

test('interruption cancels the waiting timer and discards late cue audio', async () => {
    let resolveFetch;
    let signal;
    const page = browser({fetch: (url, options) => {
        signal = options.signal;
        return new Promise(resolve => {resolveFetch = resolve;});
    }});
    page.run("state = 'thinking'; audioContext = {}; startThinkingNotice(); cancelAgentReply();");
    assert.equal(page.timeouts.size, 0);
    page.run('startThinkingNotice()');
    const pending = page.retry();
    page.run('cancelAgentReply()');
    assert.equal(signal.aborted, true);
    resolveFetch({ok: true, async json() {return {audioBase64: 'YQ=='};}});
    await pending;
    assert.equal(page.run('thinkingAudio'), undefined);
});
