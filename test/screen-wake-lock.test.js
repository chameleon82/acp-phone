import assert from 'node:assert/strict';
import test from 'node:test';
import {createScreenWakeLock} from '../src/web/public/screen-wake-lock.js';

function environment(request) {
    const listeners = new Map();
    const document = {
        visibilityState: 'visible',
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name),
    };
    const controller = createScreenWakeLock({navigator: request ? {wakeLock: {request}} : {}, document});
    return {controller, document, listeners};
}

function sentinel() {
    let onRelease;
    return {
        released: false, releases: 0,
        addEventListener(name, callback) {if (name === 'release') onRelease = callback;},
        async release() {this.released = true; this.releases++; onRelease?.();},
    };
}

test('wake lock is acquired once per visible call and released when the call stops', async () => {
    let requests = 0;
    const lock = sentinel();
    const {controller} = environment(async type => {assert.equal(type, 'screen'); requests++; return lock;});
    await Promise.all([controller.start(), controller.start()]);
    assert.equal(requests, 1);
    await controller.stop();
    assert.equal(lock.releases, 1);
});

test('returning to a visible document reacquires a released lock only during a call', async () => {
    const locks = [];
    const page = environment(async () => {const lock = sentinel(); locks.push(lock); return lock;});
    await page.controller.start();
    page.document.visibilityState = 'hidden';
    await locks[0].release();
    await page.listeners.get('visibilitychange')();
    assert.equal(locks.length, 1);
    page.document.visibilityState = 'visible';
    await page.listeners.get('visibilitychange')();
    assert.equal(locks.length, 2);
    await page.controller.stop();
    await page.listeners.get('visibilitychange')();
    assert.equal(locks.length, 2);
    await page.controller.destroy();
    assert.equal(page.listeners.size, 0);
});

test('a lock granted after hangup is released and cannot attach to a subsequent call', async () => {
    let resolveFirst;
    let requests = 0;
    const oldLock = sentinel();
    const nextLock = sentinel();
    const page = environment(() => {
        requests++;
        return requests === 1 ? new Promise(resolve => {resolveFirst = resolve;}) : Promise.resolve(nextLock);
    });
    const first = page.controller.start();
    await Promise.resolve();
    await page.controller.stop();
    void page.controller.start();
    resolveFirst(oldLock);
    await first;
    await page.controller.start();
    assert.equal(oldLock.releases, 1);
    assert.equal(requests, 2);
    assert.equal(nextLock.released, false);
    await page.controller.stop();
    assert.equal(nextLock.releases, 1);
});

test('unsupported or refused wake locks do not reject call lifecycle operations', async () => {
    const unsupported = environment();
    await unsupported.controller.start();
    await unsupported.controller.stop();
    let requests = 0;
    const denied = environment(async () => {requests++; throw new Error('Power saving mode');});
    await denied.controller.start();
    assert.equal(requests, 1);
    await denied.controller.stop();
});
