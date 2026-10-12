import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {TargetNotFoundError, VoiceCallError} from '../../domain/errors.js';
import {createAcpHttpSession} from './http-session.js';
import {createAcpStdioSession} from './stdio-session.js';

/**
 * Routes an allowed target id to an ACP session adapter.
 *
 * Adapter modules are server-side ESM files exporting `createAcpSession(target)`.
 * The function must resolve to an object with `prompt({ text, call, signal })` and
 * may provide `close()`. This keeps ACP SDK details and credentials outside core.
 */
export function createConfiguredAcpSessionFactory({targets, baseDirectory = process.cwd(), environment = process.env}) {
    const targetsById = new Map((targets ?? []).map((target) => [target.id, target]));
    const sharedHttpSessions = new Map();

    async function openHttp(configuredTarget, options) {
        if (configuredTarget.session.mode !== 'reuse-target-session') {
            return createAcpHttpSession({target: configuredTarget, environment, ...options});
        }
        let session = sharedHttpSessions.get(configuredTarget.id);
        if (!session) {
            session = Promise.resolve().then(() => createAcpHttpSession({target: configuredTarget, environment, ...options}));
            sharedHttpSessions.set(configuredTarget.id, session);
            session.catch(() => { if (sharedHttpSessions.get(configuredTarget.id) === session) sharedHttpSessions.delete(configuredTarget.id); });
        }
        return {...await session, shared: true};
    }

    return {
        async open({target, call, signal, sessionId}) {
            const configuredTarget = targetsById.get(target.id);
            if (!configuredTarget) throw new TargetNotFoundError(target.id);
            if ((configuredTarget.transport ?? 'stdio') === 'http') {
                return openHttp(configuredTarget, {call, signal, sessionId});
            }
            const resolvedTarget = {...configuredTarget, cwd: resolve(baseDirectory, configuredTarget.cwd ?? '.')};
            if (configuredTarget.adapterModule === undefined || configuredTarget.adapterModule === 'stdio') {
                return createAcpStdioSession({target: resolvedTarget, signal, sessionId});
            }
            if (!configuredTarget.adapterModule) {
                throw new VoiceCallError(`ACP target "${target.id}" does not define an adapter module.`, {
                    code: 'ACP_ADAPTER_NOT_CONFIGURED',
                    status: 500,
                });
            }

            const moduleUrl = toModuleUrl(configuredTarget.adapterModule, baseDirectory);
            let adapterModule;
            try {
                adapterModule = await import(moduleUrl);
            } catch (cause) {
                throw new VoiceCallError(`Could not load the ACP adapter for "${target.id}".`, {
                    code: 'ACP_ADAPTER_LOAD_FAILED',
                    status: 500,
                    cause,
                });
            }

            if (typeof adapterModule.createAcpSession !== 'function') {
                throw new VoiceCallError(`ACP adapter "${target.id}" must export createAcpSession().`, {
                    code: 'ACP_ADAPTER_INVALID',
                    status: 500,
                });
            }

            const session = await adapterModule.createAcpSession({
                target: resolvedTarget,
                call,
                signal,
                sessionId,
            });
            if (!session?.prompt) {
                throw new VoiceCallError(`ACP adapter "${target.id}" returned an invalid session.`, {
                    code: 'ACP_SESSION_INVALID',
                    status: 500,
                });
            }
            return session;
        },
        async close() {
            await Promise.all([...sharedHttpSessions.values()].map(async session => (await session).close()));
            sharedHttpSessions.clear();
        },
    };
}

function toModuleUrl(adapterModule, baseDirectory) {
    if (adapterModule.startsWith('file:')) return adapterModule;
    if (adapterModule.startsWith('.') || adapterModule.startsWith('/')) {
        return pathToFileURL(resolve(baseDirectory, adapterModule)).href;
    }
    return adapterModule;
}
