import {VoiceCallError} from '../../domain/errors.js';

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const MAX_RECONNECTS = 8;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Generic server-owned ACP-over-HTTP/SSE session. The browser never supplies
 * endpoint paths, request headers, method names, or session identifiers.
 */
export async function createAcpHttpSession({target, signal, sessionId, environment = process.env, fetchImpl = fetch}) {
    const requestHeaders = resolveHeaders(target, environment);
    const remoteSessionId = sessionId ?? await acquireSession({target, signal, requestHeaders, fetchImpl});
    let closed = false;
    let tail = Promise.resolve();
    let lastEventId;
    const seenEventIds = new Set();

    const request = async (method, params, requestSignal) => {
        if (closed) throw transportError(target, 'session is closed', 409);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('Remote ACP request timed out.')), REQUEST_TIMEOUT_MS);
        const combined = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
        try {
            const response = await fetchImpl(endpoint(target.baseUrl, target.session.messagePathTemplate, remoteSessionId), {
                method: 'POST', signal: combined,
                headers: {...requestHeaders, Accept: 'application/json', 'Content-Type': 'application/json'},
                body: JSON.stringify({jsonrpc: '2.0', id: crypto.randomUUID(), method, params}),
            });
            const body = await readJson(response, target, 'JSON-RPC request');
            if (!response.ok) throw transportError(target, `remote ACP request failed (${response.status})`, response.status);
            if (body?.error) throw new VoiceCallError(safeJsonRpcError(body.error), {
                code: 'ACP_REMOTE_RPC_ERROR', status: 502,
            });
            return body?.result;
        } finally { clearTimeout(timeout); }
    };

    async function initialize(requestSignal) {
        await request('initialize', {
            protocolVersion: 1, clientCapabilities: {}, clientInfo: {name: 'ACP Phone', version: '0.2.0'},
        }, requestSignal);
    }

    async function run({text, signal: turnSignal, onText}) {
        await initialize(turnSignal);
        const eventController = new AbortController();
        const combined = turnSignal ? AbortSignal.any([turnSignal, eventController.signal]) : eventController.signal;
        const events = consumeEvents({target, sessionId: remoteSessionId, requestHeaders, fetchImpl, signal: combined,
            onEventId: id => { lastEventId = id; }, seenEventIds});
        const abort = () => { void request('session/cancel', {sessionId: remoteSessionId}).catch(() => {}); };
        turnSignal?.addEventListener('abort', abort, {once: true});
        let responseText = '';
        try {
            await request('session/prompt', {sessionId: remoteSessionId, prompt: [{type: 'text', text}]}, turnSignal);
            for await (const event of events) {
                const chunk = normalizedText(event);
                if (chunk) { responseText += chunk; await onText?.(chunk); }
                if (isTurnComplete(event)) return responseText;
            }
            if (turnSignal?.aborted) turnSignal.throwIfAborted();
            throw transportError(target, 'event stream ended before the ACP turn completed', 502);
        } finally {
            eventController.abort();
            turnSignal?.removeEventListener('abort', abort);
        }
    }

    const prompt = options => {
        const next = tail.then(() => run(options));
        tail = next.catch(() => {});
        return next;
    };
    return {
        sessionId: remoteSessionId,
        prompt,
        promptStream: prompt,
        cancel: signal => request('session/cancel', {sessionId: remoteSessionId}, signal),
        setMode: (modeId, signal) => request('session/set_mode', {sessionId: remoteSessionId, modeId}, signal),
        setConfigOption: (configId, value, signal) => request('session/set_config_option', {sessionId: remoteSessionId, configId, value}, signal),
        respondToRequest: (requestId, result, signal) => request('session/respond', {sessionId: remoteSessionId, requestId, result}, signal),
        async close() {
            if (closed) return;
            closed = true;
            if (target.session.cleanupPathTemplate) {
                await fetchImpl(endpoint(target.baseUrl, target.session.cleanupPathTemplate, remoteSessionId), {
                    method: target.session.cleanupMethod ?? 'DELETE', headers: requestHeaders,
                }).catch(() => {});
            }
        },
        get isClosed() { return closed; },
        get lastEventId() { return lastEventId; },
    };
}

export async function* parseSse(body, {signal, maxBufferBytes = MAX_SSE_BUFFER_BYTES} = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = emptyEvent();
    try {
        while (true) {
            signal?.throwIfAborted();
            const {done, value} = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), {stream: !done});
            if (Buffer.byteLength(buffer) > maxBufferBytes) throw new Error('SSE buffer exceeds the configured limit.');
            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = done ? '' : lines.pop();
            for (const line of lines) {
                if (line === '') {
                    const emitted = finishEvent(event);
                    event = emptyEvent();
                    if (emitted) yield emitted;
                    continue;
                }
                if (line.startsWith(':')) continue;
                const separator = line.indexOf(':');
                const field = separator < 0 ? line : line.slice(0, separator);
                const valueText = (separator < 0 ? '' : line.slice(separator + 1)).replace(/^ /, '');
                if (field === 'id' && !valueText.includes('\0')) event.id = valueText;
                else if (field === 'event') event.event = valueText;
                else if (field === 'data') event.data.push(valueText);
                else if (field === 'retry' && /^\d+$/.test(valueText)) event.retry = Number(valueText);
            }
            if (done) {
                const emitted = finishEvent(event);
                if (emitted) yield emitted;
                return;
            }
        }
    } finally { reader.releaseLock(); }
}

async function* consumeEvents({target, sessionId, requestHeaders, fetchImpl, signal, onEventId, seenEventIds}) {
    let reconnects = 0;
    let retryMs = 250;
    let lastEventId;
    while (!signal.aborted) {
        try {
            const headers = {...requestHeaders, Accept: 'text/event-stream', ...(lastEventId ? {'Last-Event-ID': lastEventId} : {})};
            const response = await fetchImpl(endpoint(target.baseUrl, target.session.eventsPathTemplate, sessionId), {headers, signal});
            if (!response.ok || !response.body) throw transportError(target, `SSE connection failed (${response.status})`, response.status);
            reconnects = 0;
            for await (const frame of parseSse(response.body, {signal})) {
                if (frame.id) {
                    lastEventId = frame.id;
                    onEventId?.(frame.id);
                    if (seenEventIds.has(frame.id)) continue;
                    seenEventIds.add(frame.id);
                    if (seenEventIds.size > 256) seenEventIds.delete(seenEventIds.values().next().value);
                }
                if (frame.retry !== undefined) retryMs = clamp(frame.retry, 100, 5000);
                yield parseAcpEvent(frame, target);
            }
        } catch (cause) {
            if (signal.aborted) return;
            if (++reconnects > MAX_RECONNECTS) throw transportError(target, 'SSE reconnect limit reached', 502, cause);
        }
        if (signal.aborted) return;
        await delay(jitter(retryMs), signal);
        retryMs = Math.min(5000, retryMs * 2);
    }
}

async function acquireSession({target, signal, requestHeaders, fetchImpl}) {
    const session = target.session;
    if (session.mode === 'attach-existing') return session.sessionId;
    if (session.mode === 'reuse-target-session') {
        // The configured-session factory serializes these sessions per target.
        return createSession({target, signal, requestHeaders, fetchImpl});
    }
    return createSession({target, signal, requestHeaders, fetchImpl});
}

async function createSession({target, signal, requestHeaders, fetchImpl}) {
    const response = await fetchImpl(new URL(target.session.createPath, target.baseUrl), {
        method: 'POST', signal,
        headers: {...requestHeaders, Accept: 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify(target.session.createBody ?? {}),
    });
    const body = await readJson(response, target, 'session creation');
    if (!response.ok) throw transportError(target, `remote session creation failed (${response.status})`, response.status);
    const id = target.session.idPath ? getPath(body, target.session.idPath) : body?.sessionId ?? body?.id;
    if (typeof id !== 'string' || !id) throw transportError(target, 'session creation response did not contain a session ID', 502);
    return id;
}

function resolveHeaders(target, environment) {
    const headers = {...(target.headers ?? {})};
    for (const [header, variable] of Object.entries(target.headerEnv ?? {})) {
        const value = environment[variable];
        if (typeof value !== 'string' || !value) {
            throw new VoiceCallError(`ACP HTTP target "${target.id}" requires configured server environment variable "${variable}".`, {
                code: 'ACP_REMOTE_HEADER_MISSING', status: 500,
            });
        }
        headers[header] = value;
    }
    return headers;
}
function endpoint(baseUrl, template, sessionId) {
    return new URL(template.replaceAll('{sessionId}', encodeURIComponent(sessionId)), `${baseUrl}/`).href;
}
async function readJson(response, target, operation) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw transportError(target, `${operation} returned invalid JSON`, 502); }
}
function parseAcpEvent(frame, target) {
    if (!frame.data.length) return {type: 'keepalive'};
    try {
        const payload = JSON.parse(frame.data.join('\n'));
        if (payload?.jsonrpc === '2.0' && payload.method) return {type: 'notification', method: payload.method, params: payload.params};
        if (payload?.sessionUpdate || payload?.update || payload?.type) return {type: 'event', payload};
    } catch { /* reported below */ }
    throw transportError(target, 'SSE event payload is not a supported ACP JSON event', 502);
}
function normalizedText(event) {
    const update = event.params?.update ?? event.payload?.update ?? event.payload;
    if (event.method && event.method !== 'session/update') return '';
    if (update?.sessionUpdate !== 'agent_message_chunk') return '';
    const content = update.content;
    return typeof content === 'string' ? content : content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}
function isTurnComplete(event) {
    const update = event.params?.update ?? event.payload?.update ?? event.payload;
    return update?.sessionUpdate === 'stop' || event.method === 'session/stop';
}
function safeJsonRpcError(error) { return typeof error?.message === 'string' ? `Remote ACP error: ${error.message.slice(0, 500)}` : 'Remote ACP returned a JSON-RPC error.'; }
function getPath(value, path) { return path.split('.').reduce((current, key) => current?.[key], value); }
function transportError(target, message, status, cause) { return new VoiceCallError(`ACP HTTP target "${target.id}": ${message}.`, {code: 'ACP_HTTP_TRANSPORT_FAILED', status, cause}); }
function delay(milliseconds, signal) { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal?.addEventListener('abort', () => {clearTimeout(timer); reject(signal.reason);}, {once: true}); }); }
function jitter(milliseconds) { return Math.round(milliseconds * (0.75 + Math.random() * 0.5)); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function emptyEvent() { return {id: undefined, event: undefined, data: [], retry: undefined}; }
function finishEvent(event) { return event.data.length || event.id !== undefined || event.event !== undefined ? {...event, data: event.data} : undefined; }
