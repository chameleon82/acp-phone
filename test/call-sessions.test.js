import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createAcpStdioSession, createCallSessionFactory, createConfiguredAcpSessionFactory} from '../src/index.js';

const target = {id: 'test', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))]};

test('built-in stdio adapter starts an agent relative to the configuration directory', {timeout: 10_000}, async () => {
    const factory = createConfiguredAcpSessionFactory({
        baseDirectory: fileURLToPath(new URL('./fixtures/', import.meta.url)),
        targets: [{id: 'builtin', adapterModule: 'stdio', command: process.execPath, args: ['acp-agent.mjs'], cwd: '.'}],
    });
    const session = await factory.open({target: {id: 'builtin'}});
    try {assert.equal(await session.prompt({text: 'hello'}), 'Turn 1.');}
    finally {await session.close();}
});

test('stdio session preserves context across turns and after cancellation', {timeout: 10_000}, async () => {
    const session = await createAcpStdioSession({target});
    try {
        assert.equal(await session.prompt({text: 'hello'}), 'Turn 1.');
        assert.equal(await session.prompt({text: 'follow up'}), 'Turn 2.');
        const controller = new AbortController();
        await assert.rejects(session.promptStream({text: 'wait', signal: controller.signal,
            onText: () => controller.abort()}), {name: 'AbortError'});
        assert.equal(await session.prompt({text: 'continue'}), 'Turn 4.');
    } finally { await session.close(); }
});

test('call leases reuse a session, isolate calls and release it on hangup', async () => {
    let opened = 0;
    let closed = 0;
    const factory = createCallSessionFactory({factory: {open: async () => {
        const id = ++opened;
        return {prompt: async () => id, close: async () => {closed++;}};
    }}});
    const call = {id: 'first'};
    try {
        const first = await factory.open({target, call});
        await first.close();
        const second = await factory.open({target, call});
        assert.equal(await first.prompt({}), await second.prompt({}));
        const other = await factory.open({target, call: {id: 'second'}});
        assert.notEqual(await other.prompt({}), await first.prompt({}));
        assert.equal(closed, 0);
        await factory.end({target, call});
        assert.equal(closed, 1);
        const next = await factory.open({target, call});
        assert.equal(await next.prompt({}), 3);
        await assert.rejects(first.prompt({}), {name: 'AbortError'});
    } finally { await factory.close(); }
    assert.equal(closed, 3);
});


test('restores the ACP conversation after hangup and server restart without replaying history', {timeout: 10_000}, async () => {
    const {mkdtemp, rm} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'acp-resume-'));
    const persistentTarget = {...target, args: [...target.args, join(directory, 'agent-history')]};
    const storePath = join(directory, 'sessions.json');
    const underlying = {open: (options) => createAcpStdioSession(options)};
    let factory = createCallSessionFactory({factory: underlying, storePath});
    const call = {id: 'saved-call'};
    try {
        const first = await factory.open({target: persistentTarget, call});
        assert.equal(await first.prompt({text: 'hello'}), 'Turn 1.');
        await factory.end({target: persistentTarget, call});
        const second = await factory.open({target: persistentTarget, call});
        assert.equal(await second.prompt({text: 'redial'}), 'Turn 2.');
        await factory.close();
        factory = createCallSessionFactory({factory: underlying, storePath});
        const restored = await factory.open({target: persistentTarget, call});
        assert.equal(await restored.prompt({text: 'after restart'}), 'Turn 3.');
    } finally {
        await factory.close();
        await rm(directory, {recursive: true, force: true});
    }
});

test('restoring an unsupported session fails instead of silently losing context', async () => {
    await assert.rejects(createAcpStdioSession({target, sessionId: 'conversation'}), {
        code: 'ACP_RESUME_UNSUPPORTED',
    });
});

test('a process closed after cancellation reloads its saved session on reconnect', async () => {
    const loadedIds = [];
    let current;
    const factory = createCallSessionFactory({factory: {open: async ({sessionId}) => {
        loadedIds.push(sessionId);
        current = {sessionId: 'saved', isClosed: false,
            prompt: async () => 'continued', close: async () => {current.isClosed = true;}};
        return current;
    }}});
    try {
        await factory.open({target, call: {id: 'reconnect'}});
        current.isClosed = true;
        const restored = await factory.open({target, call: {id: 'reconnect'}});
        assert.equal(await restored.prompt({}), 'continued');
        assert.deepEqual(loadedIds, [undefined, 'saved']);
    } finally { await factory.close(); }
});

test('resume does not create an empty Codex session before the first voice turn', async () => {
    let opened = 0;
    const factory = createCallSessionFactory({factory: {open: async () => {
        opened++;
        return {sessionId: 'history', prompt: async () => 'reply', close() {}};
    }}});
    const call = {id: 'new'};
    try {
        assert.equal(await factory.resume({target, call}), undefined);
        assert.equal(opened, 0);
        await factory.open({target, call});
        await factory.end({target, call});
        await factory.resume({target, call});
        assert.equal(opened, 2);
    } finally {await factory.close();}
});
