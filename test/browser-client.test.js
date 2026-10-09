import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../src/web/client.js', import.meta.url), 'utf8')).replace('export function', 'function');

function host(baseUrl = 'https://phone.example') {
    const listeners = new Map();
    const nodes = [];
    const timers = new Map();
    const requests = [];
    const context = vm.createContext({
        URL, crypto: {randomUUID: () => 'channel'},
        setTimeout: callback => {timers.set(1, callback); return 1;},
        clearTimeout: id => timers.delete(id),
        window: {
            location: {origin: 'https://host.example', href: 'https://host.example/project'},
            addEventListener: (name, callback) => listeners.set(name, callback),
            removeEventListener: name => listeners.delete(name),
        },
        fetch: async (url, options) => {
            requests.push({url: url.href, options});
            return {ok: true, json: async () => ({contacts: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]})};
        },
        document: {
            body: {append(node) {node.attached = true;}},
            createElement: tag => {
                const node = {tag, style: {}, listeners: {}, messages: [],
                    setAttribute() {}, append(child) {this.child = child;},
                    addEventListener(name, callback) {this.listeners[name] = callback;},
                    showModal() {this.open = true;}, close() {this.open = false;}, remove() {this.attached = false;}};
                if (tag === 'iframe') node.contentWindow = {postMessage: (...message) => node.messages.push(message)};
                nodes.push(node);
                return node;
            },
        },
    });
    vm.runInContext(source, context);
    context.phoneBaseUrl = baseUrl;
    const phone = vm.runInContext('createAcpPhone({baseUrl: phoneBaseUrl})', context);
    return {phone, nodes, listeners, requests, timers};
}

test('browser API lists contacts and opens the requested call without navigating the host', async () => {
    const page = host();
    assert.equal((await page.phone.getContacts()).length, 2);
    assert.equal(page.requests[0].url, 'https://phone.example/api/contacts');
    let ended = 0;
    const call = page.phone.openCall('b', {onEnd: event => {assert.equal(event.contactId, 'b'); ended++;}});
    const [dialog, frame] = page.nodes;
    assert.equal(dialog.open, true);
    assert.equal(frame.allow, 'microphone; autoplay');
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
