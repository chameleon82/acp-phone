import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {once} from 'node:events';
import {createAcpPhoneApp} from '../src/web/server.js';

test('host mounts the complete phone API and call assets without config files or environment changes', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const phone = createAcpPhoneApp({
        contacts: [
            {id: 'codex', label: 'Codex', command: 'unused-codex'},
            {id: 'claude', label: 'Claude', command: 'unused-claude'},
        ],
        speech: {apiKey: 'test-private-key', baseURL: 'http://127.0.0.1:9/v1'},
        environment: {OPENAI_API_KEY: 'config-private-key'},
        sessionStorePath: false,
    });
    assert.equal(process.env.OPENAI_API_KEY, originalKey);
    const host = express();
    host.get('/', (_request, response) => response.send('My application'));
    host.use('/phone', phone.app);
    const server = host.listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const origin = `http://127.0.0.1:${server.address().port}`;
        assert.equal(await (await fetch(origin)).text(), 'My application');
        const contactsResponse = await fetch(`${origin}/phone/api/contacts`);
        const body = await contactsResponse.text();
        assert.deepEqual(JSON.parse(body), {contacts: [{id: 'codex', label: 'Codex'}, {id: 'claude', label: 'Claude'}]});
        assert.doesNotMatch(body, /private-key|unused-|environment|command/);
        for (const path of ['call?contact=claude', 'acp-phone.js', 'skins.js', 'browser-id.js', 'app.js', 'matrix-notes.js', 'screen-wake-lock.js', 'audio-check.html', 'audio-check.js', 'style.css', 'pcm-capture.js', 'manifest.webmanifest', 'pwa.js', 'sw.js', 'offline.html', 'icons/icon-192.png', 'icons/icon-512.png', 'api/health']) {
            const response = await fetch(`${origin}/phone/${path}`);
            assert.equal(response.status, 200, path);
            if (path.startsWith('call')) {
                const html = await response.text();
                assert.match(html, /src="\.\/app.js(?:\?[^\"]*)?"/);
                assert.match(html, /href="\.\/style.css(?:\?[^\"]*)?"/);
            }
        }
        const manifestUrl = `${origin}/phone/manifest.webmanifest`;
        const manifest = await (await fetch(manifestUrl)).json();
        assert.equal(new URL(manifest.start_url, manifestUrl).pathname, '/phone/call');
        assert.equal(new URL(manifest.scope, manifestUrl).pathname, '/phone/');
        assert.equal(manifest.display, 'fullscreen');
        for (const icon of manifest.icons) {
            const response = await fetch(new URL(icon.src, manifestUrl));
            const png = Buffer.from(await response.arrayBuffer());
            const size = Number(icon.sizes.split('x')[0]);
            assert.equal(png.readUInt32BE(16), size);
            assert.equal(png.readUInt32BE(20), size);
        }
        assert.equal((await fetch(`${origin}/phone/contacts.js`)).status, 404);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await phone.close();
    }
});

test('embedding rejects duplicate contacts and invalid environment before opening sessions', () => {
    const contact = {id: 'a', label: 'A', command: 'unused'};
    assert.throws(() => createAcpPhoneApp({contacts: [contact, contact]}), /unique IDs/);
    assert.throws(() => createAcpPhoneApp({contacts: [contact], environment: {KEY: 42}}), /string values/);
    assert.throws(() => createAcpPhoneApp({contacts: [{...contact, environment: 'invalid'}]}), /Contact/);
});
