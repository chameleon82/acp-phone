import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {ACP_PHONE_SKINS, isSkin} from '../src/web/skins.js';
import {createBrowserId} from '../src/web/browser-id.js';

const source = (await readFile(new URL('../src/web/client.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*\};\n/gm, '').replace('export function', 'function');

test('LAN HTTP without randomUUID creates distinct UUID channels from secure random bytes', () => {
    let seed = 0;
    const crypto = {getRandomValues(bytes) {bytes.fill(++seed); return bytes;}};
    const page = host('http://192.168.1.176:3000', undefined, {mobile: true, crypto});
    const first = page.phone.openCall('a');
    const channel = new URL(page.nodes[1].src).searchParams.get('channel');
    assert.match(channel, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    first.close();
    page.timers.get(1)();
    page.phone.openCall('b');
    assert.notEqual(new URL(page.nodes[3].src).searchParams.get('channel'), channel);
});

function host(baseUrl = 'https://phone.example', skin = 'default', {mobile = false, requestFullscreen, crypto = {randomUUID: () => 'channel'}} = {}) {
    const listeners = new Map();
    const nodes = [];
    const timers = new Map();
    const requests = [];
    const diagnostics = new Map();
    const context = vm.createContext({
        URL, ACP_PHONE_SKINS, isSkin, createBrowserId, crypto,
        sessionStorage: {setItem: (key, value) => diagnostics.set(key, value)},
        setTimeout: callback => {timers.set(1, callback); return 1;},
        clearTimeout: id => timers.delete(id),
        window: {
            matchMedia: () => ({matches: mobile}),
            location: {origin: 'https://host.example', href: 'https://host.example/project'},
            addEventListener: (name, callback) => listeners.set(name, callback),
            removeEventListener: name => listeners.delete(name),
        },
        fetch: async (url, options) => {
            requests.push({url: url.href, options});
            return {ok: true, json: async () => ({contacts: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]})};
        },
        document: {
            body: {style: {overflow: 'auto'}, append(node) {node.attached = true;}},
            createElement: tag => {
                const node = {tag, style: {}, listeners: {}, messages: [],
                    setAttribute() {}, append(child) {this.child = child;},
                    addEventListener(name, callback) {this.listeners[name] = callback;},
                    showModal() {this.open = true;}, close() {this.open = false;}, remove() {this.attached = false;}};
                if (tag === 'iframe') node.contentWindow = {postMessage: (...message) => node.messages.push(message)};
                if (tag === 'div' && requestFullscreen) node.requestFullscreen = options => requestFullscreen(node, options, context.document);
                if (tag !== 'div') nodes.push(node);
                return node;
            },
        },
    });
    vm.runInContext(source, context);
    context.phoneBaseUrl = baseUrl;
    context.phoneSkin = skin;
    const phone = vm.runInContext('createAcpPhone({baseUrl: phoneBaseUrl, skin: phoneSkin})', context);
    return {phone, nodes, listeners, requests, timers, diagnostics, document: context.document,
        audioReady(index = 0) {
            const frame = nodes[index + 1];
            listeners.get('message')({origin: new URL(frame.src).origin, source: frame.contentWindow,
                data: {type: 'acp-phone.audio-ready', channel: new URL(frame.src).searchParams.get('channel')}});
        }};
}

test('browser API lists contacts and opens the requested call without navigating the host', async () => {
    const page = host();
    assert.equal((await page.phone.getContacts()).length, 2);
    assert.equal(page.requests[0].url, 'https://phone.example/api/contacts');
    let ended = 0;
    const call = page.phone.openCall('b', {onEnd: event => {assert.equal(event.contactId, 'b'); ended++;}});
    const [dialog, frame] = page.nodes;
    assert.equal(dialog.open, true);
    assert.equal(frame.allow, 'microphone; autoplay; screen-wake-lock');
    const url = new URL(frame.src);
    assert.equal(url.pathname, '/call');
    assert.equal(url.searchParams.get('contact'), 'b');
    assert.equal(url.searchParams.get('hostOrigin'), 'https://host.example');
    assert.throws(() => page.phone.openCall('a'), /already open/);
    const receive = page.listeners.get('message');
    const valid = {origin: 'https://phone.example', source: frame.contentWindow,
        data: {type: 'acp-phone.ended', channel: 'channel'}};
    receive({...valid, origin: 'https://other.example'});
    receive({...valid, source: {}});
    receive({...valid, data: {...valid.data, channel: 'wrong'}});
    assert.equal(ended, 0);
    call.close();
    call.close();
    assert.equal(frame.messages.length, 1);
    assert.equal(frame.messages[0][0].type, 'acp-phone.end');
    assert.equal(frame.messages[0][1], 'https://phone.example');
    receive(valid);
    receive(valid);
    assert.equal(ended, 1);
    assert.equal(dialog.attached, false);
    assert.equal(page.listeners.has('message'), false);
    assert.equal(page.timers.size, 0);
    page.phone.openCall('a');
});

test('escape requests hangup and a lost frame still closes the modal', () => {
    const page = host();
    let ended = 0;
    page.phone.openCall('a', {onEnd: () => ended++});
    let prevented = false;
    page.nodes[0].listeners.cancel({preventDefault() {prevented = true;}});
    assert.equal(prevented, true);
    assert.equal(page.nodes[1].messages.length, 1);
    page.timers.get(1)();
    assert.equal(ended, 1);
    assert.equal(page.nodes[0].attached, false);
});

test('browser API preserves the host mount path for contacts and calls', async () => {
    const page = host('https://host.example/phone');
    await page.phone.getContacts();
    assert.equal(page.requests[0].url, 'https://host.example/phone/api/contacts');
    page.phone.openCall('claude');
    assert.equal(new URL(page.nodes[1].src).pathname, '/phone/call');
});

test('a default skin can be overridden per call and unknown skins never open a frame', () => {
    const page = host('https://phone.example', 'telegram');
    const call = page.phone.openCall('a');
    assert.equal(new URL(page.nodes[1].src).searchParams.get('skin'), 'telegram');
    page.listeners.get('message')({origin: 'https://phone.example', source: page.nodes[1].contentWindow,
        data: {type: 'acp-phone.ended', channel: 'channel'}});
    page.phone.openCall('b', {skin: 'whatsapp'});
    assert.equal(new URL(page.nodes[3].src).searchParams.get('skin'), 'whatsapp');
    call.close();
    assert.throws(() => page.phone.openCall('b', {skin: 'unknown'}), /Unknown ACP Phone skin/);
    assert.throws(() => host('https://phone.example', 'unknown'), /Unknown ACP Phone skin/);
});

test('mobile calls defer their single fullscreen request until iframe audio is ready, then restore the host', async () => {
    let requested = false;
    let exits = 0;
    const page = host(undefined, undefined, {mobile: true, requestFullscreen(frame, options, document) {
        requested = true;
        assert.equal(options.navigationUI, 'hide');
        document.fullscreenElement = frame;
        return Promise.resolve();
    }});
    page.document.exitFullscreen = async () => {exits++; page.document.fullscreenElement = null;};
    page.phone.openCall('a');
    assert.equal(requested, false);
    page.audioReady();
    const [dialog, frame] = page.nodes;
    assert.equal(requested, true);
    assert.equal(page.document.fullscreenElement, dialog.child);
    assert.equal(dialog.child.child, frame);
    assert.equal(dialog.style.width, '100vw');
    assert.equal(dialog.style.height, '100dvh');
    assert.equal(dialog.style.margin, '0');
    assert.equal(frame.allowFullscreen, true);
    assert.equal(page.document.body.style.overflow, 'hidden');
    await Promise.resolve();
    page.listeners.get('message')({origin: 'https://phone.example', source: frame.contentWindow,
        data: {type: 'acp-phone.ended', channel: 'channel'}});
    assert.equal(exits, 1);
    assert.equal(page.document.body.style.overflow, 'auto');
});

test('fullscreen denial keeps the mobile call open and fullscreen can be disabled', async () => {
    let requests = 0;
    const page = host(undefined, undefined, {mobile: true, requestFullscreen() {
        requests++;
        return Promise.reject(new Error('Not allowed'));
    }});
    const call = page.phone.openCall('a');
    page.audioReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.nodes[0].open, true);
    const rejected = JSON.parse(page.diagnostics.get('acp-phone.fullscreen-diagnostic')).at(-1);
    assert.equal(rejected.result, 'request-rejected');
    assert.match(rejected.error, /Not allowed/);
    call.close();
    page.timers.get(1)();
    page.phone.openCall('b', {fullscreen: false});
    page.audioReady(2);
    assert.equal(requests, 1);
    assert.equal(page.nodes[2].style.width, '100vw');
});

test('desktop fullscreen is opt-in and a late grant is released after hangup', async () => {
    let grant;
    let exits = 0;
    const page = host(undefined, undefined, {requestFullscreen(frame, options, document) {
        return new Promise(resolve => {grant = () => {document.fullscreenElement = frame; resolve();};});
    }});
    page.document.exitFullscreen = async () => {exits++; page.document.fullscreenElement = null;};
    const first = page.phone.openCall('a');
    assert.equal(grant, undefined);
    first.close();
    page.timers.get(1)();
    const second = page.phone.openCall('b', {fullscreen: true});
    page.audioReady(2);
    second.close();
    page.timers.get(1)();
    grant();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exits, 1);
    assert.equal(page.document.body.style.overflow, 'auto');
});
