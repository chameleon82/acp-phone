import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ValidationError} from '../domain/errors.js';

/** Keeps one ACP session per call; turn close releases only its lease. */
export function createCallSessionFactory({factory, idleMs = 15 * 60_000, storePath}) {
    const calls = new Map();
    const saved = new Map();
    const loaded = storePath ? readFile(storePath, 'utf8').then((text) => {
        for (const [key, value] of JSON.parse(text)) saved.set(key, value);
    }).catch((error) => { if (error.code !== 'ENOENT') throw error; }) : Promise.resolve();
    loaded.catch(() => {}); // Report storage failures from open(), not as unhandled rejections.
    let writes = Promise.resolve();
    function persist() {
        if (!storePath) return Promise.resolve();
        const data = JSON.stringify([...saved]);
        const write = writes.then(async () => {
            await mkdir(dirname(storePath), {recursive: true});
            await writeFile(`${storePath}.tmp`, data, {mode: 0o600});
            await rename(`${storePath}.tmp`, storePath);
        });
        writes = write.catch(() => {});
        return write;
    }
    function key(target, call) {
        if (typeof call?.id !== 'string' || !call.id.trim() || call.id.length > 128) {
            throw new ValidationError('A call id of 1–128 characters is required.');
        }
        return JSON.stringify([target.id, call.id]);
    }
    async function end({target, call}) {
        const id = key(target, call);
        const entry = calls.get(id);
        if (!entry) return;
        calls.delete(id);
        clearTimeout(entry.timer);
        entry.controller.abort();
        const session = await entry.session.catch(() => undefined);
        if (!session?.shared) await session?.close?.();
    }
    function touch(entry, target, call) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { void end({target, call}).catch(() => {}); }, idleMs);
        entry.timer.unref?.();
    }
    return {
        async resume({target, call, signal}) {
            await loaded;
            const id = key(target, call);
            // Codex writes history only after the first prompt. Do not create
            // an empty session during microphone setup and save an unloadable ID.
            if (!saved.has(id) && !calls.has(id)) return;
            return this.open({target, call, signal});
        },
        async open({target, call, signal}) {
            await loaded;
            signal?.throwIfAborted();
            const id = key(target, call);
            let entry = calls.get(id);
            if (entry && (await entry.session).isClosed) {
                await end({target, call});
                entry = undefined;
            }
            if (!entry) {
                entry = {controller: new AbortController()};
                entry.session = Promise.resolve().then(() => factory.open({
                    target, call, sessionId: saved.get(id), signal: entry.controller.signal,
                })).then(async (session) => {
                    if (session.sessionId) {
                        saved.set(id, session.sessionId);
                        try { await persist(); } catch (error) { await session.close?.(); throw error; }
                    }
                    return session;
                });
                calls.set(id, entry);
                entry.session.catch(() => {
                    if (calls.get(id) === entry) {
                        calls.delete(id);
                        clearTimeout(entry.timer);
                    }
                });
            }
            touch(entry, target, call);
            const session = await entry.session;
            signal?.throwIfAborted();
            if (entry.controller.signal.aborted) throw new ValidationError('The call has ended.');
            const wrap = (method) => async (options) => {
                entry.controller.signal.throwIfAborted();
                touch(entry, target, call);
                try {
                    return await method.call(session, options);
                } catch (error) {
                    if (!options.signal?.aborted || session.isClosed) await end({target, call});
                    throw error;
                }
            };
            return {
                prompt: wrap(session.prompt),
                ...(session.promptStream ? {promptStream: wrap(session.promptStream)} : {}),
                close: async () => {},
            };
        },
        end,
        async close() {
            await Promise.all([...calls.keys()].map((id) => {
                const [targetId, callId] = JSON.parse(id);
                return end({target: {id: targetId}, call: {id: callId}});
            }));
            await factory.close?.();
        },
    };
}
