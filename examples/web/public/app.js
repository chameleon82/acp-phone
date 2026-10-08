const screen = document.querySelector('.call-screen');
const callButton = document.querySelector('#call');
const callLabel = document.querySelector('#call-label');
const callIcon = document.querySelector('#call-icon');
const muteButton = document.querySelector('#mute');
const muteLabel = document.querySelector('#mute-label');
const speakerButton = document.querySelector('#speaker');
const targetSelect = document.querySelector('#target');
const targetProfile = document.querySelector('#target-profile');
const targetLabel = document.querySelector('#target-label');
const agentName = document.querySelector('#agent-name');
const avatar = document.querySelector('#avatar');
const callTimer = document.querySelector('#call-timer');
const status = document.querySelector('#status');
const voicePrompt = document.querySelector('#voice-prompt');
const transcript = document.querySelector('#transcript');
const agentText = document.querySelector('#agent-text');

const STORAGE_KEY = 'acp-phone.conversations';
const TARGET_STORAGE_KEY = 'acp-phone.target';
let conversations = {};
try { conversations = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch {}
if (!conversations || typeof conversations !== 'object' || Array.isArray(conversations)) conversations = {};

function saveConversations() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch {}
}

const VAD_THRESHOLD = 0.025;
const START_SPEECH_MS = 120;
const PRE_ROLL_MS = 350;
const END_SILENCE_MS = 850;
const MIN_UTTERANCE_MS = 250;

let microphone;
let recordingStream;
let audioContext;
let analyser;
let recorder;
let vadFrame;
let speechStartedAt;
let silenceStartedAt;
let state = 'loading';
let callStartedAt;
let timerId;
let muted = false;
let speakerEnabled = true;
let activeRequest;
let currentAudio;
let audioQueue = [];
let playingQueue = false;
let callId;
let callGeneration = 0;
let playbackGeneration = 0;
let stopPlayback;
let failPlayback;
let healthTimer;
let recoveryTimer;
let recoveryRequest;
let healthRequest;
let serverInstanceId;
let recoveryDelay = 1000;

await loadTargets();
callButton.addEventListener('click', () => state === 'ready' ? startCall() : endCall());
window.addEventListener('pagehide', () => endCall({release: false}));
window.addEventListener('online', () => {
    if (state === 'reconnecting') {
        clearTimeout(recoveryTimer);
        void reconnectCall();
    }
});
muteButton.addEventListener('click', toggleMicrophone);
speakerButton.addEventListener('click', toggleSpeaker);
targetSelect.addEventListener('change', () => {
    try { localStorage.setItem(TARGET_STORAGE_KEY, targetSelect.value); } catch {}
    renderTarget();
});
targetProfile.addEventListener('click', () => {
    if (state === 'ready') targetSelect.focus();
});

async function loadTargets() {
    try {
        const response = await fetch('/api/targets');
        if (!response.ok) throw new Error('Unable to load configured ACP targets.');
        const {targets} = await response.json();
        for (const target of targets) targetSelect.add(new Option(target.label, target.id));
        if (!targets.length) throw new Error('No ACP targets are configured.');
        try {
            const selected = localStorage.getItem(TARGET_STORAGE_KEY);
            if (targets.some((target) => target.id === selected)) targetSelect.value = selected;
        } catch {}
        renderTarget();
        setState('ready', 'Ready to call', 'Tap Call, then simply speak naturally.');
    } catch (error) {
        setState('error', error.message, 'Configure an ACP target, then try again.');
    }
}

async function startCall() {
    const generation = ++callGeneration;
    const savedCall = conversations[targetSelect.value];
    callId = typeof savedCall === "string" && savedCall.length > 0 && savedCall.length <= 128
        ? savedCall : crypto.randomUUID();
    conversations[targetSelect.value] = callId;
    saveConversations();
    try { localStorage.setItem(TARGET_STORAGE_KEY, targetSelect.value); } catch {}
    transcript.textContent = '—';
    agentText.textContent = '—';
    setState('connecting', 'Connecting…', 'Restoring your conversation and opening the microphone.');
    callStartedAt = Date.now();
    startTimer();
    screen.classList.add('in-call');
    callButton.classList.add('in-call');
    callLabel.textContent = 'End';
    callIcon.textContent = '☎';
    muteButton.disabled = false;
    speakerButton.disabled = false;
    muted = false;
    renderMuteControl();
    const request = new AbortController();
    activeRequest = request;
    let connected = false;
    try {
        const response = await fetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}/resume`, {
            method: 'POST', signal: request.signal,
        });
        if (!response.ok) {
            const {error} = await response.json();
            throw new Error(error.message);
        }
        if (generation !== callGeneration) return;
        connected = true;
        await openMicrophone(generation);
        if (generation !== callGeneration) return;
        setState('connected', 'Connected · listening', 'Speak normally. Your turn sends automatically after a short pause.');
        monitorVoice();
        healthTimer = setInterval(() => { void checkConnection(); }, 5000);
        void checkConnection();
    } catch (error) {
        if (generation !== callGeneration) return;
        endCall({release: false});
        setState('ready', `${connected ? 'Microphone unavailable' : 'Connection unavailable'}: ${error.message}`,
            'Tap Call to retry this conversation.');
    } finally {
        if (activeRequest === request) activeRequest = undefined;
    }
}

function endCall({release = true} = {}) {
    if (callId && release) {
        void fetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}`, {
            method: 'DELETE', keepalive: true,
        }).catch(() => {});
    }
    callId = undefined;
    ++callGeneration;
    clearInterval(healthTimer);
    clearTimeout(recoveryTimer);
    healthTimer = undefined;
    recoveryTimer = undefined;
    recoveryRequest?.abort();
    healthRequest?.abort();
    recoveryRequest = undefined;
    healthRequest = undefined;
    serverInstanceId = undefined;
    speechStartedAt = undefined;
    silenceStartedAt = undefined;
    cancelAgentReply();
    stopRecorder();
    cancelAnimationFrame(vadFrame);
    vadFrame = undefined;
    microphone?.getTracks().forEach((track) => track.stop());
    microphone = undefined;
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = undefined;
    audioContext?.close();
    audioContext = undefined;
    analyser = undefined;
    clearInterval(timerId);
    timerId = undefined;
    screen.classList.remove('in-call', 'recording', 'playing', 'thinking');
    callButton.classList.remove('in-call', 'recording');
    callLabel.textContent = 'Call';
    callIcon.textContent = '☎';
    muteButton.disabled = true;
    speakerButton.disabled = true;
    callTimer.textContent = 'Call ended';
    setState('ready', 'Ready to call', 'Tap Call to continue this conversation.');
}

function toggleMicrophone() {
    muted = !muted;
    microphone?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    speechStartedAt = undefined;
    silenceStartedAt = undefined;
    renderMuteControl();
    if (state === 'reconnecting') return;
    if (muted) {
        stopRecorder();
        setState('connected', 'Microphone muted', 'Unmute when you are ready to speak.');
    } else if (state !== 'ready') {
        setState('connected', 'Connected · listening', 'Speak normally. Your turn sends automatically after a short pause.');
    }
}

function toggleSpeaker() {
    speakerEnabled = !speakerEnabled;
    if (currentAudio) {
        currentAudio.muted = !speakerEnabled;
        if (speakerEnabled) {
            const rejectPlayback = failPlayback;
            // Browsers can pause media when it becomes audible again.
            // Resume within the button's user gesture so the queue can finish.
            currentAudio.play().catch((error) => rejectPlayback?.(error));
        }
    }
    speakerButton.classList.toggle('active', speakerEnabled);
    speakerButton.setAttribute('aria-pressed', String(speakerEnabled));
}

async function openMicrophone(generation) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('Use a supported browser over HTTPS or localhost.');
    }
    const context = new AudioContext();
    audioContext = context;
    const resumed = context.resume();
    resumed.catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    });
    if (generation !== callGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
    }
    microphone = stream;
    await resumed;
    if (generation !== callGeneration) return;

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(microphone);
    source.connect(analyser);
    // Detect live speech, but record delayed audio so the start includes sound
    // from before VAD fired. The 850 ms end silence also drains this 350 ms buffer.
    const delay = audioContext.createDelay(1);
    delay.delayTime.value = PRE_ROLL_MS / 1000;
    const destination = audioContext.createMediaStreamDestination();
    source.connect(delay).connect(destination);
    recordingStream = destination.stream;
}

function monitorVoice() {
    if (!analyser || state === 'ready') return;
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
        vadFrame = requestAnimationFrame(tick);
        if (muted || !analyser || state === 'reconnecting') return;
        analyser.getByteTimeDomainData(samples);
        const level = rms(samples);
        const now = performance.now();
        if (level >= VAD_THRESHOLD) {
            silenceStartedAt = undefined;
            if (!recorder) {
                if (!speechStartedAt) speechStartedAt = now;
                if (now - speechStartedAt >= START_SPEECH_MS) beginUtterance();
            } else if (state === 'playing' || state === 'thinking') {
                cancelAgentReply();
                setState('recording', 'Listening', 'I heard you. Continue speaking; your turn sends after a pause.');
            }
            return;
        }
        speechStartedAt = undefined;
        if (!recorder) return;
        if (!silenceStartedAt) silenceStartedAt = now;
        if (now - silenceStartedAt >= END_SILENCE_MS && now - recorder.startedAt >= MIN_UTTERANCE_MS) {
            finishUtterance();
        }
    };
    tick();
}

function beginUtterance() {
    if (!recordingStream || muted || recorder) return;
    cancelAgentReply();
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
    recorder = new MediaRecorder(recordingStream, mimeType ? {mimeType} : undefined);
    recorder.startedAt = performance.now();
    const chunks = [];
    const currentRecorder = recorder;
    const generation = callGeneration;
    currentRecorder.send = () => {
        if (generation === callGeneration) void sendUtterance(chunks, currentRecorder.mimeType);
    };
    recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
    recorder.addEventListener('stop', currentRecorder.send, {once: true});
    recorder.start();
    silenceStartedAt = undefined;
    setState('recording', 'Listening', 'Listening… I will send when you finish speaking.');
}

function finishUtterance() {
    const currentRecorder = recorder;
    if (!currentRecorder || currentRecorder.state !== 'recording') return;
    recorder = undefined;
    silenceStartedAt = undefined;
    setState('thinking', 'Thinking…', 'Your voice is transcribing and the agent is responding.');
    currentRecorder.stop();
}

function stopRecorder() {
    if (!recorder) return;
    const currentRecorder = recorder;
    recorder = undefined;
    currentRecorder.removeEventListener('stop', currentRecorder.send);
    if (currentRecorder.state === 'recording') currentRecorder.stop();
}

async function sendUtterance(chunks, mimeType) {
    const blob = new Blob(chunks, {type: mimeType || 'audio/webm'});
    if (!blob.size || state === 'ready' || state === 'reconnecting') return;
    cancelAgentReply();
    agentText.textContent = '—';
    const form = new FormData();
    form.append('audio', blob, blob.type.includes('mp4') ? 'turn.mp4' : 'turn.webm');
    form.append('callId', callId);
    form.append('locale', navigator.language.split('-')[0]);
    const request = new AbortController();
    activeRequest = request;
    try {
        const response = await fetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/turn/stream`, {
            method: 'POST', body: form, signal: request.signal,
        });
        if (!response.ok) {
            const {error} = await response.json().catch(() => ({error: {message: 'Voice turn failed.'}}));
            throw Object.assign(new Error(error.message), {retryable: response.status >= 500});
        }
        await consumeStream(response.body, request.signal);
        if (request.signal.aborted) return;
        if (state !== 'ready' && !playingQueue) {
            setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
        }
    } catch (error) {
        if (!request.signal.aborted && error.name !== 'AbortError' && state !== 'ready') {
            if (error.name === 'TypeError' || error.retryable) beginReconnect();
            else setState('connected', error.message, 'Speak again to try another turn.');
        }
    } finally {
        if (activeRequest === request) activeRequest = undefined;
    }
}

async function consumeStream(body, signal) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let remainder = '';
    let completed = false;
    const consume = (line) => {
        const event = JSON.parse(line);
        if (event.type === 'turn.completed') completed = true;
        handleStreamEvent(event);
    };
    while (true) {
        const {value, done} = await reader.read();
        if (signal.aborted) return;
        if (done) break;
        remainder += value;
        const lines = remainder.split('\n');
        remainder = lines.pop();
        for (const line of lines) if (line.trim()) consume(line);
    }
    if (remainder.trim()) consume(remainder);
    if (!completed && !signal.aborted) throw Object.assign(new Error('Connection interrupted.'), {retryable: true});
}

function beginReconnect() {
    if (!callId || state === 'ready' || state === 'reconnecting') return;
    cancelAgentReply();
    stopRecorder();
    speechStartedAt = undefined;
    silenceStartedAt = undefined;
    recoveryDelay = 1000;
    setState('reconnecting', 'Reconnecting…', 'Your call is still active. Waiting for the server to restore this conversation.');
    recoveryTimer = setTimeout(reconnectCall, recoveryDelay);
}

async function reconnectCall() {
    if (state !== 'reconnecting' || !callId || recoveryRequest) return;
    const generation = callGeneration;
    const request = new AbortController();
    recoveryRequest = request;
    try {
        const response = await fetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}/resume`, {
            method: 'POST', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        });
        if (generation !== callGeneration) return;
        if (!response.ok) {
            if (response.status >= 500) throw new Error('Server unavailable');
            const {error} = await response.json();
            // Keep the call and its ID, but make permanent restore errors visible.
            setState('connected', error.message, 'End the call and tap Call to restore this conversation.');
            return;
        }
        serverInstanceId = undefined;
        setState('connected', muted ? 'Microphone muted' : 'Connected · listening',
            muted ? 'Unmute when you are ready to speak.' : 'Connection restored. Speak to continue this conversation.');
    } catch {
        if (generation === callGeneration && !request.signal.aborted) {
            recoveryDelay = Math.min(recoveryDelay * 2, 5000);
            recoveryTimer = setTimeout(reconnectCall, recoveryDelay);
        }
    } finally {
        if (recoveryRequest === request) recoveryRequest = undefined;
    }
}

async function checkConnection() {
    if (!callId || ['ready', 'connecting', 'reconnecting'].includes(state) || activeRequest || healthRequest) return;
    const generation = callGeneration;
    const request = new AbortController();
    healthRequest = request;
    try {
        const response = await fetch('/api/health', {
            cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error('Server unavailable');
        const {instanceId} = await response.json();
        if (generation !== callGeneration || request.signal.aborted) return;
        if (serverInstanceId && serverInstanceId !== instanceId) beginReconnect();
        serverInstanceId = instanceId;
    } catch {
        if (generation === callGeneration && !request.signal.aborted) beginReconnect();
    } finally {
        if (healthRequest === request) healthRequest = undefined;
    }
}

function handleStreamEvent(event) {
    if (event.type === 'transcript.final') transcript.textContent = event.transcript;
    if (event.type === 'turn.completed') agentText.textContent = event.agentText;
    if (event.type === 'agent.text.delta') agentText.textContent = `${agentText.textContent === '—' ? '' : agentText.textContent}${event.delta}`;
    if (event.type === 'tts.audio') {
        enqueueAudio(event);
        setState('playing', 'Agent is speaking', 'You can interrupt naturally by speaking.');
    }
    if (event.type === 'error') throw Object.assign(new Error(event.message), {
        retryable: event.code === 'ACP_PROCESS_FAILED',
    });
}

function enqueueAudio(event) {
    audioQueue.push(event);
    if (!playingQueue) void playAudioQueue();
}

async function playAudioQueue() {
    const generation = playbackGeneration;
    playingQueue = true;
    try {
        while (audioQueue.length && state !== 'ready' && generation === playbackGeneration) {
            const next = audioQueue.shift();
            const url = URL.createObjectURL(new Blob([base64Bytes(next.audioBase64)], {type: next.contentType}));
            const audio = audioContext
                ? await createVoicePlayback(next, audioContext)
                : new Audio(url);
            if (generation !== playbackGeneration) {
                audio.pause();
                URL.revokeObjectURL(url);
                break;
            }
            currentAudio = audio;
            audio.muted = !speakerEnabled;
            try {
                await new Promise((resolve, reject) => {
                    stopPlayback = resolve;
                    failPlayback = reject;
                    audio.addEventListener('ended', resolve, {once: true});
                    audio.addEventListener('error', () => reject(new Error('Audio playback failed.')), {once: true});
                    audio.play().catch(reject);
                });
            } finally {
                audio.pause();
                URL.revokeObjectURL(url);
                if (currentAudio === audio) currentAudio = undefined;
            }
        }
    } catch (error) {
        if (generation === playbackGeneration) {
            audioQueue = [];
            setState('connected', error.message, 'The response is available in Call notes. Speak to continue.');
        }
    } finally {
        if (generation === playbackGeneration) {
            playingQueue = false;
            stopPlayback = undefined;
            failPlayback = undefined;
            if (state === 'playing') setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
        }
    }
}

async function createVoicePlayback(event, context) {
    const buffer = await context.decodeAudioData(base64Bytes(event.audioBase64).buffer);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    let started = false;
    let stopped = false;
    return {
        set muted(value) { gain.gain.value = value ? 0 : 1; },
        addEventListener(type, listener, options) { source.addEventListener(type, listener, options); },
        async play() {
            await context.resume();
            if (!started && !stopped) { source.start(); started = true; }
        },
        pause() {
            if (stopped) return;
            stopped = true;
            if (started) source.stop();
            source.disconnect();
            gain.disconnect();
        },
    };
}

function cancelAgentReply() {
    activeRequest?.abort();
    activeRequest = undefined;
    ++playbackGeneration;
    audioQueue = [];
    currentAudio?.pause();
    stopPlayback?.();
    stopPlayback = undefined;
    failPlayback = undefined;
    currentAudio = undefined;
    playingQueue = false;
}

function base64Bytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function rms(samples) {
    let sum = 0;
    for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
    }
    return Math.sqrt(sum / samples.length);
}

function renderTarget() {
    const label = targetSelect.selectedOptions[0]?.textContent ?? 'Choose an agent';
    callLabel.textContent = 'Call';
    targetLabel.textContent = label;
    agentName.textContent = label;
    avatar.textContent = label.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase() || 'AI';
}

function renderMuteControl() {
    muteButton.classList.toggle('active', !muted);
    muteButton.setAttribute('aria-pressed', String(!muted));
    muteLabel.textContent = muted ? 'Mic off' : 'Mic on';
}

function setState(nextState, statusMessage, prompt) {
    state = nextState;
    status.textContent = statusMessage;
    voicePrompt.textContent = prompt;
    const inCall = !['loading', 'ready', 'error'].includes(nextState);
    screen.classList.toggle('recording', nextState === 'recording');
    screen.classList.toggle('playing', nextState === 'playing');
    screen.classList.toggle('thinking', nextState === 'thinking');
    callButton.classList.toggle('recording', nextState === 'recording');
    callButton.disabled = nextState === 'loading' || nextState === 'error';
    callButton.setAttribute('aria-pressed', String(inCall));
    muteButton.disabled = !inCall || nextState === 'connecting';
    speakerButton.disabled = !inCall || nextState === 'connecting';
    targetSelect.disabled = inCall;
    targetProfile.disabled = inCall;
}

function startTimer() {
    updateTimer();
    timerId = setInterval(updateTimer, 1_000);
}

function updateTimer() {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1_000);
    const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
    const remainder = String(seconds % 60).padStart(2, '0');
    callTimer.textContent = `${state === 'reconnecting' ? 'Reconnecting' : 'Connected'} · ${minutes}:${remainder}`;
}
