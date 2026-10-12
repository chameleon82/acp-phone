import assert from 'node:assert/strict';
import test from 'node:test';

import {createAcpHttpSession, normalizeAcpPhoneConfig, parseSse, resolveConfigPath, resolveListenerSettings} from '../src/index.js';

const remoteTarget = {
    id: 'remote', label: 'Remote', transport: 'http', baseUrl: 'http://remote.test:8080',
    headers: {'X-Client-Name': 'acp-phone'}, headerEnv: {Authorization: 'REMOTE_TOKEN'},
    session: {mode: 'create-per-call', createPath: '/create', messagePathTemplate: '/messages/{sessionId}',
        eventsPathTemplate: '/events/{sessionId}', createBody: {agent: 'example'}},
};

test('existing stdio configuration remains valid and HTTP validation rejects unsafe ambiguity', () => {
    const config = normalizeAcpPhoneConfig({targets: [{id: 'local', label: 'Local', command: 'agent'}]});
    assert.equal(config.targets[0].transport, 'stdio');
    const valid = normalizeAcpPhoneConfig({targets: [remoteTarget]});
    assert.equal(valid.targets[0].session.mode, 'create-per-call');
    for (const target of [
        {...remoteTarget, baseUrl: 'ftp://remote.test'},
        {...remoteTarget, baseUrl: 'https://token@remote.test'},
        {...remoteTarget, session: {...remoteTarget.session, eventsPathTemplate: '/events'}},
        {...remoteTarget, session: {...remoteTarget.session, mode: 'attach-existing'}},
    ]) assert.throws(() => normalizeAcpPhoneConfig({targets: [target]}));
    assert.throws(() => normalizeAcpPhoneConfig({targets: [remoteTarget, {...remoteTarget}]}), /unique/);
});

test('listener settings apply CLI, environment, config, then secure defaults', () => {
    assert.deepEqual(resolveListenerSettings({argv: ['--host', 'localhost', '--port', '4444'], environment: {ACP_PHONE_PORT: '3333'}, config: {host: 'example.test', port: 2222}}),
        {host: 'localhost', port: 4444, publicBaseUrl: undefined});
    assert.equal(resolveListenerSettings({environment: {ACP_PHONE_PORT: '3333'}, config: {port: 2222}}).port, 3333);
    assert.equal(resolveListenerSettings({config: {port: 2222}}).port, 2222);
    assert.equal(resolveListenerSettings({}).host, '127.0.0.1');
    assert.throws(() => resolveListenerSettings({environment: {ACP_PHONE_PORT: '0'}}), /1 through 65535/);
    assert.equal(resolveConfigPath({argv: ['--config', 'custom.json'], cwd: '/tmp'}), '/tmp/custom.json');
});

test('generic HTTP ACP creates a session, URL-encodes it, sends JSON-RPC, and streams normalized text', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({url: String(url), init});
        if (String(url).endsWith('/create')) return json({sessionId: 'agent/a b'});
        if (String(url).includes('/events/')) return sse([
            'id: 1\n', 'event: message\n', 'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello "}}}}\n\n',
            'id: 2\n', 'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"stop"}}}\n\n',
        ]);
        return json({jsonrpc: '2.0', id: 'request', result: {}});
    };
    const session = await createAcpHttpSession({target: remoteTarget, environment: {REMOTE_TOKEN: 'secret-value'}, fetchImpl});
    assert.equal(await session.promptStream({text: 'private prompt'}), 'Hello ');
    assert.deepEqual(JSON.parse(calls[0].init.body), {agent: 'example'});
    const message = calls.find(call => call.url.includes('/messages/'));
    assert.match(message.url, /agent%2Fa%20b/);
    assert.equal(message.init.headers.Authorization, 'secret-value');
    assert.equal(JSON.parse(message.init.body).method, 'initialize');
    assert.ok(calls.some(call => JSON.parse(call.init.body ?? '{}').method === 'session/prompt'));
});

test('SSE parser handles fragmented UTF-8, comments, multiline data, IDs and retry', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({start(controller) {
        for (const text of [': keepalive\n', 'id: 9\nretry: 1500\ndata: {"x":', '"✓"}\ndata: second\n\n']) controller.enqueue(encoder.encode(text));
        controller.close();
    }});
    const frames = [];
    for await (const frame of parseSse(stream)) frames.push(frame);
    assert.deepEqual(frames, [{id: '9', event: undefined, retry: 1500, data: ['{"x":"✓"}', 'second']}]);
});

function json(value) { return new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}); }
function sse(parts) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); }}),
        {headers: {'Content-Type': 'text/event-stream'}});
}
