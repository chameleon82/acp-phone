import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {TargetNotFoundError, VoiceCallError} from '../../domain/errors.js';

/**
 * Routes an allowed target id to an ACP session adapter.
 *
 * Adapter modules are server-side ESM files exporting `createAcpSession(target)`.
 * The function must resolve to an object with `prompt({ text, call, signal })` and
 * may provide `close()`. This keeps ACP SDK details and credentials outside core.
 */
export function createConfiguredAcpSessionFactory({targets, baseDirectory = process.cwd()}) {
    const targetsById = new Map((targets ?? []).map((target) => [target.id, target]));

    return {
        async open({target, call, signal, sessionId}) {
            const configuredTarget = targetsById.get(target.id);
            if (!configuredTarget) throw new TargetNotFoundError(target.id);
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
                target: configuredTarget,
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
    };
}

function toModuleUrl(adapterModule, baseDirectory) {
    if (adapterModule.startsWith('file:')) return adapterModule;
    if (adapterModule.startsWith('.') || adapterModule.startsWith('/')) {
        return pathToFileURL(resolve(baseDirectory, adapterModule)).href;
    }
    return adapterModule;
}