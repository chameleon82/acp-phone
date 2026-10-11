import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/web/public/sw.js', import.meta.url), 'utf8');
function worker(fetch) {
    const handlers = new Map();
    const cached = new Response('reconnect');
    const deleted = [];
    const added = [];
    let claimed = false;
    vm.runInNewContext(source, {
        URL, Response, fetch,
        self: {
            registration: {scope: 'https://phone.example/phone/'},
            addEventListener: (name, handler) => handlers.set(name, handler),
            clients: {claim: async () => {claimed = true;}},
        },
        caches: {
            open: async () => ({add: async url => added.push(url), match: async () => cached}),
            keys: async () => ['other-app', 'acp-phone-offline:https://phone.example/other/:v0',
                'acp-phone-offline:https://phone.example/phone/:v0',
                'acp-phone-offline:https://phone.example/phone/:v1'],
            delete: async name => deleted.push(name),
        },
    });
    return {handlers, cached, deleted, added, claimed: () => claimed};
}
function navigate(worker, path, overrides = {}) {
    let result;
    worker.handlers.get('fetch')({
        request: {url: new URL(path, 'https://phone.example').href, mode: 'navigate', method: 'GET', ...overrides},
        respondWith: promise => {result = promise;},
    });
    return result;
}

test('PWA caches its reconnect page and removes only obsolete caches in its own scope', async () => {
    const w = worker();
    for (const name of ['install', 'activate']) {
        let pending;
        w.handlers.get(name)({waitUntil: promise => {pending = promise;}});
        await pending;
    }
    assert.deepEqual(w.added, ['https://phone.example/phone/offline.html']);
    assert.deepEqual(w.deleted, ['acp-phone-offline:https://phone.example/phone/:v0']);
    assert.equal(w.claimed(), true);
});

test('PWA returns live navigation and falls back to reconnect only on network failure', async () => {
    const live = new Response('live');
    assert.equal(await navigate(worker(async () => live), '/phone/call'), live);
    const offline = worker(async () => {throw new Error('offline');});
    assert.equal(await navigate(offline, '/phone/call'), offline.cached);
});

test('PWA leaves API, audio, assets, other apps and non-GET requests to the browser', () => {
    const w = worker(() => {throw new Error('must not intercept');});
    for (const [path, overrides] of [
        ['/phone/api/contacts', {}], ['/phone/call', {method: 'POST'}],
        ['/phone/audio', {mode: 'cors'}], ['/phone/app.js', {mode: 'no-cors'}],
        ['/other/call', {}], ['https://other.example/phone/call', {}],
    ]) assert.equal(navigate(w, path, overrides), undefined);
});
