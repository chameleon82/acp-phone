// Requests and assets follow the mount path of the built-in call screen.
import {isSkin} from './skins.js';
import {animateMatrixNotes} from './matrix-notes.js?v=changing-symbols-25';
import {createScreenWakeLock} from './screen-wake-lock.js';
import {createBrowserId} from './browser-id.js';
function phonePath(path) {
    const prefix = (window.location?.pathname ?? '/').replace(/\/+$/, '').replace(/\/[^/]*$/, '');
    return `${prefix}${path}`;
}
function phoneFetch(path, options) { return fetch(phonePath(path), options); }

const screen = document.querySelector('.call-screen');
const contactsView = document.querySelector('#contacts-view');
const callView = document.querySelector('#call-view');
const contactsStatus = document.querySelector('#contacts-status');
const callButton = document.querySelector('#call');
const callLabel = document.querySelector('#call-label');
const callIcon = document.querySelector('#call-icon');
const muteButton = document.querySelector('#mute');
const muteLabel = document.querySelector('#mute-label');
const speakerButton = document.querySelector('#speaker');
const targetSelect = document.querySelector('#target');
const agentList = document.querySelector('#agent-list');
const targetProfile = document.querySelector('#target-profile');
const targetLabel = document.querySelector('#target-label');
const agentName = document.querySelector('#agent-name');
const avatar = document.querySelector('#avatar');
const callTimer = document.querySelector('#call-timer');
const status = document.querySelector('#status');
const voicePrompt = document.querySelector('#voice-prompt');
const transcript = document.querySelector('#transcript');
const transcriptStatus = document.querySelector('#transcript-status');
const agentText = document.querySelector('#agent-text');
const launchParameters = new URLSearchParams(window.location?.search ?? '');
const keepScreenAwake = launchParameters.get('keepAwake') !== 'false';
const requestedSkin = launchParameters.get('skin') ?? 'default';
document.documentElement.dataset.skin = isSkin(requestedSkin) ? requestedSkin : 'default';
let matrixNotes;
let matrixReplyComplete = false;
let matrixReplyAudio = false;
if (requestedSkin === 'matrix' && window.MutationObserver) {
    matrixNotes = animateMatrixNotes({document, MutationObserver: window.MutationObserver,
        notes: document.querySelector('.conversation'), sources: [transcript, agentText],
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false});
    window.addEventListener('pagehide', () => matrixNotes.destroy());
}

function finishMatrixReading() {
    if (!matrixReplyComplete || !matrixReplyAudio || playingQueue || audioQueue.length || !speakerEnabled) return;
    matrixReplyComplete = false;
    matrixNotes?.dissolve();
}
const directContactId = launchParameters.get('contact');
const hostChannel = launchParameters.get('channel');
const hostOrigin = launchParameters.get('hostOrigin');

function notifyCallEnded() {
    if (hostChannel && hostOrigin && window.parent !== window) {
        window.parent.postMessage({type: 'acp-phone.ended', channel: hostChannel}, hostOrigin);
    }
}

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
let candidateRequest;
let greetingRequest;
let awaitingAgent = false;
let hangupTimer;
let hangupContext;
let ringingTimer;
let ringingInterval;
let ringingContext;
let pickupTimer;
let finishPickupWait;
let previousGreeting = '';
let currentAudio;
let audioQueue = [];
let playingQueue = false;
let pcmPlayback;
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
let liveTranscription;
let transcriptGeneration = 0;
let transcriptFinalized = false;
let thinkingTimer;
let thinkingRequest;
let thinkingAudio;
let previousThinkingPhrase = '';
const screenWakeLock = createScreenWakeLock({navigator, document});
let ownsFullscreen = false;

function recordCallFullscreen(result, error) {
    const events = [{result, error: error ? `${error.name}: ${error.message}` : undefined,
        source: 'call-page', active: Boolean(document.fullscreenElement), enabled: document.fullscreenEnabled,
        userActivation: navigator.userActivation?.isActive}];
    try {localStorage.setItem('acp-phone.fullscreen-diagnostic', JSON.stringify(events));} catch {}
}

function exitCallFullscreen() {
    if (ownsFullscreen && document.fullscreenElement === document.documentElement) {
        try {Promise.resolve(document.exitFullscreen?.()).catch(() => {});} catch {}
    }
    ownsFullscreen = false;
}

function requestCallFullscreen(generation) {
    if (hostChannel) return; // The host requests fullscreen within the contact click.
    if (document.fullscreenElement) {recordCallFullscreen('entered-fullscreen'); return;}
    if (!document.documentElement.requestFullscreen) {recordCallFullscreen('API-unavailable'); return;}
    recordCallFullscreen('requesting');
    try {
        ownsFullscreen = true;
        Promise.resolve(document.documentElement.requestFullscreen({navigationUI: 'hide'})).then(() => {
            recordCallFullscreen('request-resolved');
            if (generation !== callGeneration) exitCallFullscreen();
        }).catch(error => {ownsFullscreen = false; recordCallFullscreen('request-rejected', error);});
    } catch (error) {ownsFullscreen = false; recordCallFullscreen('request-threw', error);}
}

callButton.addEventListener('click', () => state === 'ready' && !hostChannel ? startCall() : endCall({animate: true}));
window.addEventListener('message', event => {
    if (!hostChannel || event.source !== window.parent || event.origin !== hostOrigin
        || event.data?.channel !== hostChannel || event.data.type !== 'acp-phone.end') return;
    endCall({animate: true});
});
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
    if (state === 'ready') void startCall();
});

await loadTargets();

async function loadTargets() {
    const generation = callGeneration;
    try {
        const response = await phoneFetch('/api/contacts');
        if (!response.ok) throw new Error('Unable to load configured ACP targets.');
        const {contacts: targets} = await response.json();
        if (generation !== callGeneration) return;
        for (const target of targets) targetSelect.add(new Option(target.label, target.id));
        if (!targets.length) throw new Error('No ACP targets are configured.');
        if (!directContactId) renderAgentList(targets);
        try {
            const selected = localStorage.getItem(TARGET_STORAGE_KEY);
            if (targets.some((target) => target.id === selected)) targetSelect.value = selected;
        } catch {}
        if (directContactId) {
            if (!targets.some(target => target.id === directContactId)) throw new Error('Unknown ACP Phone contact.');
            targetSelect.value = directContactId;
        }
        renderTarget();
        setState('ready', 'Ready to call', 'Choose an agent to start a call.');
        if (directContactId) await startCall();
    } catch (error) {
        setState('error', error.message, 'Configure an ACP target, then try again.');
    }
}

function renderAgentList(targets) {
    agentList.replaceChildren();
    for (const target of targets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-contact';
        const icon = document.createElement('span');
        icon.className = 'contact-avatar';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = target.label.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
        const name = document.createElement('span');
        name.className = 'contact-name';
        name.textContent = target.label;
        const action = document.createElement('span');
        action.className = 'contact-action';
        action.textContent = 'Call';
        button.append(icon, name, action);
        button.addEventListener('click', () => callAgent(target.id));
        agentList.append(button);
    }
}

async function callAgent(id) {
    if (state !== 'ready') return;
    targetSelect.value = id;
    try {localStorage.setItem(TARGET_STORAGE_KEY, id);} catch {}
    renderTarget();
    await startCall();
}

async function startCall() {
    const generation = ++callGeneration;
    const dialingStartedAt = Date.now();
    startRinging(generation);
    const savedCall = conversations[targetSelect.value];
    callId = typeof savedCall === "string" && savedCall.length > 0 && savedCall.length <= 128
        ? savedCall : createBrowserId(crypto);
    conversations[targetSelect.value] = callId;
    saveConversations();
    try { localStorage.setItem(TARGET_STORAGE_KEY, targetSelect.value); } catch {}
    transcript.textContent = '—';
    agentText.textContent = '—';
    setState('connecting', 'Connecting…', 'Restoring your conversation and opening the microphone.');
    if (keepScreenAwake) void screenWakeLock.start();
    callStartedAt = Date.now();
    startTimer();
    screen.classList.add('in-call');
    callButton.classList.add('in-call');
    callLabel.textContent = 'End';
    muteButton.disabled = false;
    speakerButton.disabled = false;
    muted = false;
    renderMuteControl();
    const request = new AbortController();
    activeRequest = request;
    let connected = false;
    try {
        const response = await phoneFetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}/resume`, {
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
        await waitForPickup(dialingStartedAt);
        if (generation !== callGeneration) return;
        stopRinging();
        setState('connected', 'Connected · listening', 'Speak normally. Your turn sends automatically after a short pause.');
        monitorVoice();
        void startLiveTranscription();
        void playGreeting(generation);
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

function waitForPickup(startedAt) {
    const remaining = Math.max(0, 2000 - (Date.now() - startedAt));
    if (!remaining) return Promise.resolve();
    return new Promise(resolve => {
        finishPickupWait = resolve;
        pickupTimer = setTimeout(() => {
            pickupTimer = undefined;
            finishPickupWait = undefined;
            resolve();
        }, remaining);
    });
}

async function playGreeting(generation) {
    if (!speakerEnabled || state === 'ready' || state === 'reconnecting') return;
    const request = new AbortController();
    greetingRequest = request;
    const replyGeneration = playbackGeneration;
    try {
        const response = await phoneFetch('/api/greeting-audio', {method: 'POST',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify({previous: previousGreeting}),
            signal: request.signal});
        if (!response.ok) return;
        const event = await response.json();
        if (request.signal.aborted || generation !== callGeneration || replyGeneration !== playbackGeneration
            || !speakerEnabled || recorder || candidateRequest || state === 'ready' || state === 'reconnecting') return;
        agentText.textContent = event.text;
        previousGreeting = event.text;
        stopRinging();
        enqueueAudio(event);
        setState('playing', 'Connected · agent is speaking', 'Speak whenever you are ready.');
    } catch {
        // Greeting failures must not prevent a connected call from continuing.
    } finally {
        if (greetingRequest === request) {
            greetingRequest = undefined;
            stopRinging();
        }
    }
}

function endCall({release = true, animate = false} = {}) {
    exitCallFullscreen();
    void screenWakeLock.stop();
    clearTimeout(pickupTimer);
    pickupTimer = undefined;
    finishPickupWait?.();
    finishPickupWait = undefined;
    stopRinging();
    clearTimeout(hangupTimer);
    hangupTimer = undefined;
    hangupContext?.close();
    hangupContext = undefined;
    if (callId && release) {
        void phoneFetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}`, {
            method: 'DELETE', keepalive: true,
        }).catch(() => {});
    }
    callId = undefined;
    ++callGeneration;
    stopLiveTranscription();
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
    muteButton.disabled = true;
    speakerButton.disabled = true;
    callTimer.textContent = 'Call ended';
    setState('ready', 'Ready to call', 'Tap Call to continue this conversation.');
    if (animate) {
        const generation = callGeneration;
        setState('ending', 'Call ended', 'The call has ended.');
        callLabel.textContent = 'Ended';
        hangupTimer = setTimeout(() => {
            if (generation !== callGeneration) return;
            hangupTimer = undefined;
            hangupContext?.close();
            hangupContext = undefined;
            setState('ready', 'Ready to call', 'Choose an agent to start a call.');
            notifyCallEnded();
        }, 2000);
        if (speakerEnabled) void playHangupSound(generation);
    }
}

function startRinging(generation) {
    stopRinging();
    if (!speakerEnabled) return;
    try {
        const context = new AudioContext();
        ringingContext = context;
        void context.resume().catch(() => {});
        const ring = () => {
            if (generation !== callGeneration || ringingContext !== context) return;
            try {
                const start = context.currentTime + 0.02;
                for (const offset of [0, 0.3]) {
                    for (const frequency of [440, 480]) {
                        const oscillator = context.createOscillator();
                        const gain = context.createGain();
                        oscillator.frequency.value = frequency;
                        gain.gain.setValueAtTime(0, start + offset);
                        gain.gain.linearRampToValueAtTime(0.04, start + offset + 0.015);
                        gain.gain.linearRampToValueAtTime(0, start + offset + 0.2);
                        oscillator.connect(gain).connect(context.destination);
                        oscillator.start(start + offset);
                        oscillator.stop(start + offset + 0.22);
                        oscillator.addEventListener('ended', () => {oscillator.disconnect(); gain.disconnect();}, {once: true});
                    }
                }
            } catch {stopRinging();}
        };
        ringingTimer = setTimeout(() => {
            ringingTimer = undefined;
            if (generation !== callGeneration || ringingContext !== context) return;
            ring();
            if (ringingContext === context) ringingInterval = setInterval(ring, 2200);
        }, 1000);
    } catch {stopRinging();}
}

function stopRinging() {
    clearTimeout(ringingTimer);
    clearInterval(ringingInterval);
    ringingTimer = undefined;
    ringingInterval = undefined;
    ringingContext?.close();
    ringingContext = undefined;
}

async function playHangupSound(generation) {
    try {
        const context = new AudioContext();
        hangupContext = context;
        await context.resume();
        if (generation !== callGeneration || state !== 'ending') {await context.close(); return;}
        const start = context.currentTime + 0.02;
        for (const [offset, frequency] of [[0, 440], [0.32, 330], [0.64, 220]]) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0, start + offset);
            gain.gain.linearRampToValueAtTime(0.12, start + offset + 0.015);
            gain.gain.linearRampToValueAtTime(0, start + offset + 0.26);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start(start + offset);
            oscillator.stop(start + offset + 0.28);
            oscillator.addEventListener('ended', () => {oscillator.disconnect(); gain.disconnect();}, {once: true});
        }
    } catch {
        // Visual confirmation still completes if audio output is unavailable.
    }
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
    if (!speakerEnabled) {stopThinkingNotice(); stopRinging();}
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
    if (hostChannel && hostOrigin && window.parent !== window) {
        window.parent?.postMessage({type: 'acp-phone.audio-ready', channel: hostChannel}, hostOrigin);
    } else requestCallFullscreen(generation);

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
    if (requestedSkin === 'matrix' && !playingQueue && !awaitingAgent && !activeRequest) {
        agentText.textContent = '—';
    }
    stopRinging();
    greetingRequest?.abort();
    greetingRequest = undefined;
    candidateRequest?.abort();
    candidateRequest = undefined;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
    recorder = new MediaRecorder(recordingStream, mimeType ? {mimeType} : undefined);
    recorder.startedAt = performance.now();
    ++transcriptGeneration;
    transcriptFinalized = false;
    if (liveTranscription) {
        resetLivePreview();
        liveTranscription.token = transcriptGeneration;
        transcript.textContent = '…';
    }
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
    resetLivePreview();
    currentRecorder.stop();
}

function stopRecorder() {
    resetLivePreview();
    if (!recorder) return;
    const currentRecorder = recorder;
    recorder = undefined;
    currentRecorder.removeEventListener('stop', currentRecorder.send);
    if (currentRecorder.state === 'recording') currentRecorder.stop();
}

async function sendUtterance(chunks, mimeType) {
    const blob = new Blob(chunks, {type: mimeType || 'audio/webm'});
    if (!blob.size || state === 'ready' || state === 'reconnecting') return;
    candidateRequest?.abort();
    const form = new FormData();
    form.append('audio', blob, blob.type.includes('mp4') ? 'turn.mp4' : 'turn.webm');
    form.append('callId', callId);
    form.append('locale', navigator.language.split('-')[0]);
    const request = new AbortController();
    candidateRequest = request;
    try {
        const response = await phoneFetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/turn/stream`, {
            method: 'POST', body: form, signal: request.signal,
        });
        if (!response.ok) {
            const {error} = await response.json().catch(() => ({error: {message: 'Voice turn failed.'}}));
            throw Object.assign(new Error(error.message), {retryable: response.status >= 500});
        }
        await consumeStream(response.body, request.signal, (event) => {
            if (request.signal.aborted) return;
            if (candidateRequest === request && event.type !== 'turn.skipped' && event.type !== 'error') {
                // STT confirms speech before we cancel the previous agent turn.
                cancelAgentReply({preserveCandidate: true});
                candidateRequest = undefined;
                activeRequest = request;
                awaitingAgent = true;
                agentText.textContent = '—';
                setState('thinking', 'Thinking…', 'The agent is responding.');
                startThinkingNotice();
            }
            if (event.type === 'turn.skipped' && candidateRequest === request) {
                candidateRequest = undefined;
                transcriptFinalized = true;
                transcript.textContent = '—';
                if (playingQueue) setState('playing', 'Agent is speaking', 'You can interrupt naturally by speaking.');
                else setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
                return;
            }
            handleStreamEvent(event);
        });
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
        if (candidateRequest === request) candidateRequest = undefined;
        if (activeRequest === request) {
            awaitingAgent = false;
            stopThinkingNotice();
            activeRequest = undefined;
        }
    }
}

async function consumeStream(body, signal, onEvent = handleStreamEvent) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let remainder = '';
    let completed = false;
    const consume = (line) => {
        const event = JSON.parse(line);
        if (event.type === 'turn.completed' || event.type === 'turn.skipped') completed = true;
        onEvent(event);
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
    stopLiveTranscription();
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
        const response = await phoneFetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/${encodeURIComponent(callId)}/resume`, {
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
        void startLiveTranscription();
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
        const response = await phoneFetch('/api/health', {
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
    if (event.type === 'turn.skipped') {
        stopThinkingNotice();
        transcriptFinalized = true;
        transcript.textContent = '—';
        setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
        return;
    }
    if (event.type === 'transcript.final') {
        transcriptFinalized = true;
        transcript.textContent = event.transcript;
    }
    if (event.type === 'turn.completed') {
        awaitingAgent = false;
        stopThinkingNotice();
        agentText.textContent = event.agentText;
        void pcmPlayback?.flush().catch(() => cancelAgentReply());
        matrixReplyComplete = true;
        finishMatrixReading();
    }
    if (event.type === 'agent.text.delta') {
        if (event.delta?.trim()) {
            stopRinging();
            stopThinkingNotice();
            if (awaitingAgent && activeRequest) startThinkingNotice(25000);
        }
        agentText.textContent = `${agentText.textContent === '—' ? '' : agentText.textContent}${event.delta}`;
    }
    if (event.type === 'tts.audio') {
        matrixReplyAudio = true;
        stopRinging();
        stopThinkingNotice();
        enqueueAudio(event);
        setState('playing', 'Agent is speaking', 'You can interrupt naturally by speaking.');
        if (awaitingAgent && activeRequest) startThinkingNotice(25000);
    }
    if (event.type === 'error') throw Object.assign(new Error(event.message), {
        retryable: event.code === 'ACP_PROCESS_FAILED',
    });
}

function startThinkingNotice(delay = 1000, preserveCue = false) {
    if (preserveCue) clearTimeout(thinkingTimer);
    else stopThinkingNotice();
    const generation = playbackGeneration;
    thinkingTimer = setTimeout(async () => {
        thinkingTimer = undefined;
        if (generation !== playbackGeneration || !speakerEnabled || !audioContext
            || ['ready', 'reconnecting', 'recording'].includes(state)) return;
        if (playingQueue) {
            if (awaitingAgent && activeRequest) startThinkingNotice(25000);
            return;
        }
        const message = transcriptFinalized ? transcript.textContent : '';
        const language = /[а-яё]/i.test(message) || navigator.language?.startsWith('ru') ? 'ru' : 'en';
        const request = new AbortController();
        thinkingRequest = request;
        let cue;
        try {
            const response = await phoneFetch('/api/thinking-audio', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, signal: request.signal,
                body: JSON.stringify({transcript: message.slice(0, 1000),
                    draft: agentText.textContent === '—' ? '' : agentText.textContent.slice(-500),
                    previous: previousThinkingPhrase, language}),
            });
            if (!response.ok) return;
            cue = createPcmPlayback(audioContext);
            if (request.signal.aborted || generation !== playbackGeneration) return;
            thinkingAudio = cue;
            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            let pending = '';
            try {
                while (true) {
                    const {value, done} = await reader.read();
                    if (request.signal.aborted || generation !== playbackGeneration) return;
                    if (done) {await cue.flush(); break;}
                    pending += value;
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        const event = JSON.parse(line);
                        if (event.text) previousThinkingPhrase = event.text;
                        await cue.append(event);
                    }
                }
            } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
        } catch {
            // A waiting cue is optional and must never interrupt the actual reply.
            cue?.pause();
        } finally {
            if (thinkingRequest === request) thinkingRequest = undefined;
            if (!request.signal.aborted && generation === playbackGeneration && awaitingAgent && activeRequest) {
                startThinkingNotice(25000, true);
            }
        }
    }, delay);
}


function stopThinkingNotice() {
    clearTimeout(thinkingTimer);
    thinkingTimer = undefined;
    thinkingRequest?.abort();
    thinkingRequest = undefined;
    thinkingAudio?.pause();
    thinkingAudio = undefined;
}

async function startLiveTranscription() {
    if (!recordingStream || !audioContext || liveTranscription || state === 'ready' || state === 'reconnecting') return;
    const context = audioContext;
    const generation = callGeneration;
    if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
        transcriptStatus.textContent = 'Text appears after your pause.';
        return;
    }
    try {
        await context.audioWorklet.addModule(phonePath('/pcm-capture.js'));
        if (generation !== callGeneration || state === 'reconnecting') return;
        const source = context.createMediaStreamSource(recordingStream);
        const node = new AudioWorkletNode(context, 'pcm-capture');
        const output = context.createGain();
        output.gain.value = 0;
        source.connect(node).connect(output).connect(context.destination);
        const preview = {source, node, output, sampleRate: context.sampleRate,
            samples: new Float32Array(0), text: '', token: recorder ? transcriptGeneration : undefined};
        liveTranscription = preview;
        transcriptStatus.textContent = 'Text updates while you speak.';
        node.port.onmessage = ({data}) => {
            if (liveTranscription !== preview || !recorder || muted || preview.token === undefined) return;
            const combined = new Float32Array(preview.samples.length + data.length);
            combined.set(preview.samples);
            combined.set(data, preview.samples.length);
            // Keep memory bounded if the gateway is slow during a long utterance.
            preview.samples = combined.slice(-preview.sampleRate * 30);
            void updateLivePreview(preview);
        };
    } catch {
        if (generation === callGeneration) transcriptStatus.textContent = 'Text appears after your pause.';
    }
}

async function updateLivePreview(preview) {
    const detectingInterruption = (playingQueue || activeRequest || thinkingAudio || thinkingRequest)
        && (preview.interruptAttempts || 0) < 2;
    const seconds = detectingInterruption ? (preview.interruptAttempts ? 1.2 : 0.8) : 4;
    const count = Math.round(preview.sampleRate * seconds);
    if (preview.request || preview.token === undefined || preview.samples.length < count ||
        Date.now() < (preview.retryAfter || 0)) return;
    const token = preview.token;
    const replyGeneration = playbackGeneration;
    if (detectingInterruption) preview.interruptAttempts = (preview.interruptAttempts || 0) + 1;
    const audio = encodePreviewWav(preview.samples.slice(0, count), preview.sampleRate);
    // Repeat 350 ms at boundaries so the preview can recognize split words.
    preview.samples = preview.samples.slice(count - Math.round(preview.sampleRate * PRE_ROLL_MS / 1000));
    const request = new AbortController();
    preview.request = request;
    const form = new FormData();
    form.append('audio', audio, 'preview.wav');
    try {
        const response = await phoneFetch(`/api/calls/${encodeURIComponent(targetSelect.value)}/transcription`, {
            method: 'POST', body: form,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error('Preview unavailable');
        const {transcript: text} = await response.json();
        if (request.signal.aborted || liveTranscription !== preview || preview.token !== token ||
            transcriptGeneration !== token || transcriptFinalized) return;
        if ((playingQueue || activeRequest || thinkingAudio || thinkingRequest)
            && replyGeneration === playbackGeneration && hasRecognizedSpeech(text)) {
            cancelAgentReply({preserveCandidate: true});
            if (requestedSkin === 'matrix') agentText.textContent = '—';
            if (recorder) setState('recording', 'Listening', 'I heard you. Continue speaking; your turn sends after a pause.');
        }
        preview.text = mergePreviewText(preview.text, text);
        transcript.textContent = preview.text || '…';
        transcriptStatus.textContent = 'Text updates while you speak.';
    } catch {
        if (!request.signal.aborted && liveTranscription === preview && preview.token === token) {
            preview.retryAfter = Date.now() + 5000;
            transcriptStatus.textContent = 'Text appears after your pause.';
        }
    } finally {
        if (preview.request === request) {
            preview.request = undefined;
            if (liveTranscription === preview && preview.token === token) void updateLivePreview(preview);
        }
    }
}

function hasRecognizedSpeech(text) {
    return typeof text === 'string' && /[\p{L}\p{N}]/u.test(text)
        && !/^\s*\[(?:silence|noise|background noise|music|тишина|шум|музыка)\]\s*$/iu.test(text);
}

function mergePreviewText(previous, next) {
    const left = previous.trim().split(/\s+/).filter(Boolean);
    const right = String(next ?? '').trim().split(/\s+/).filter(Boolean);
    const normalize = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    let overlap = 0;
    for (let size = 1; size <= Math.min(left.length, right.length, 12); size++) {
        if (left.slice(-size).every((word, index) => normalize(word) === normalize(right[index]))) overlap = size;
    }
    return [...left, ...right.slice(overlap)].join(' ');
}

function encodePreviewWav(samples, rate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return new Blob([buffer], {type: 'audio/wav'});
}

function resetLivePreview() {
    const preview = liveTranscription;
    if (!preview) return;
    preview.token = undefined;
    preview.request?.abort();
    preview.request = undefined;
    preview.samples = new Float32Array(0);
    preview.text = '';
    preview.retryAfter = 0;
    preview.interruptAttempts = 0;
}

function stopLiveTranscription() {
    const preview = liveTranscription;
    resetLivePreview();
    liveTranscription = undefined;
    if (preview) {
        preview.node.port.onmessage = null;
        preview.source.disconnect();
        preview.node.disconnect();
        preview.output.disconnect();
    }
    transcriptStatus.textContent = 'Text appears after your pause.';
}

function enqueueAudio(event) {
    if (event.encoding === 'pcm_s16le' && audioContext) {
        void enqueuePcmAudio(event);
        return;
    }
    audioQueue.push(event);
    if (!playingQueue) void playAudioQueue();
}

async function enqueuePcmAudio(event) {
    const generation = playbackGeneration;
    if (!pcmPlayback) {
        pcmPlayback = createPcmPlayback(audioContext, () => {
            if (generation !== playbackGeneration) return;
            pcmPlayback = undefined;
            currentAudio = undefined;
            playingQueue = false;
            finishMatrixReading();
            if (state === 'playing') setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
        });
    }
    const playback = pcmPlayback;
    currentAudio = playback;
    playingQueue = true;
    playback.muted = !speakerEnabled;
    try {
        await playback.append(event);
    } catch (error) {
        if (generation === playbackGeneration) {
            cancelAgentReply();
            setState('connected', error.message, 'The response is available in Call notes. Speak to continue.');
        }
    }
}

function createPcmPlayback(context, onIdle = () => {}) {
    const sources = new Set();
    let queued = [];
    let queuedSeconds = 0;
    let nextTime;
    let stopped = false;
    let muted = false;
    let pending = 0;
    let flushing = Promise.resolve();
    const idle = () => {
        if (!stopped && !pending && !queued.length && !sources.size) onIdle();
    };
    const playback = {
        set muted(value) {muted = value; for (const source of sources) source.muted = value;},
        async play() {await context.resume();},
        pause() {
            stopped = true;
            for (const source of sources) source.pause();
            sources.clear();
            queued = [];
        },
        async append(event) {
            pending++;
            try {
                const audio = await createVoicePlayback(event, context);
                if (stopped) {audio.pause(); return;}
                sources.add(audio);
                audio.muted = muted;
                audio.addEventListener('ended', () => {audio.pause(); sources.delete(audio); idle();}, {once: true});
                const duration = base64Bytes(event.audioBase64).length / (2 * event.sampleRate);
                queued.push({audio, duration});
                queuedSeconds += duration;
                // Buffer actual samples before starting, rather than assuming the
                // next network packet will arrive within a fixed clock delay.
                if (nextTime !== undefined || queuedSeconds >= 0.5 - 1e-6) await playback.flush();

            } finally {pending--; idle();}
        },
        flush() {
            flushing = flushing.then(async () => {
                await context.resume();
                if (stopped) return;
                const ready = queued;
                queued = [];
                queuedSeconds = 0;
                for (const {audio, duration} of ready) {
                    const startTime = Math.max(nextTime ?? context.currentTime + 0.03, context.currentTime + 0.015);
                    nextTime = startTime + duration;
                    await audio.play(startTime);
                    if (stopped) return;
                }
            });
            return flushing;
        },
    };
    return playback;
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
            matrixReplyAudio = false;
            setState('connected', error.message, 'The response is available in Call notes. Speak to continue.');
        }
    } finally {
        if (generation === playbackGeneration) {
            playingQueue = false;
            stopPlayback = undefined;
            failPlayback = undefined;
            finishMatrixReading();
            if (state === 'playing') setState('connected', 'Connected · listening', 'Speak whenever you are ready.');
        }
    }
}

async function createVoicePlayback(event, context) {
    const bytes = base64Bytes(event.audioBase64);
    let buffer;
    if (event.encoding === 'pcm_s16le') {
        if (!bytes.length || bytes.length % 2 || event.sampleRate !== 24000) throw new Error('Invalid streamed audio.');
        buffer = context.createBuffer(1, bytes.length / 2, event.sampleRate);
        const samples = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    } else {
        buffer = await context.decodeAudioData(bytes.buffer);
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    let started = false;
    let stopped = false;
    return {
        set muted(value) { gain.gain.value = value ? 0 : 1; },
        addEventListener(type, listener, options) { source.addEventListener(type, listener, options); },
        async play(startTime) {
            await context.resume();
            if (!started && !stopped) { source.start(startTime); started = true; }
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

function cancelAgentReply({preserveCandidate = false} = {}) {
    matrixReplyComplete = false;
    matrixReplyAudio = false;
    matrixNotes?.cancel();
    awaitingAgent = false;
    greetingRequest?.abort();
    greetingRequest = undefined;
    if (!preserveCandidate) {
        candidateRequest?.abort();
        candidateRequest = undefined;
    }
    stopThinkingNotice();
    activeRequest?.abort();
    activeRequest = undefined;
    ++playbackGeneration;
    audioQueue = [];
    currentAudio?.pause();
    pcmPlayback = undefined;
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
    callIcon.setAttribute('data-mode', hostChannel || inCall ? 'end' : 'call');
    contactsView.hidden = Boolean(directContactId) || inCall;
    callView.hidden = !directContactId && !inCall;
    contactsStatus.textContent = inCall ? '' : statusMessage;
    screen.classList.toggle('in-call', inCall);
    screen.classList.toggle('recording', nextState === 'recording');
    screen.classList.toggle('playing', nextState === 'playing');
    screen.classList.toggle('thinking', nextState === 'thinking');
    callButton.classList.toggle('recording', nextState === 'recording');
    callButton.disabled = nextState === 'ending' || (!hostChannel && ['loading', 'error'].includes(nextState));
    if (hostChannel && ['loading', 'ready', 'error'].includes(nextState)) callLabel.textContent = 'End';
    callButton.setAttribute('aria-pressed', String(inCall));
    muteButton.disabled = !inCall || ['connecting', 'ending'].includes(nextState);
    speakerButton.disabled = !inCall || ['connecting', 'ending'].includes(nextState);
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
