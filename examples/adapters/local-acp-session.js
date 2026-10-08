import {createAcpStdioSession} from '../../src/adapters/acp/stdio-session.js';

/**
 * Connects the example's trusted local target to an ACP stdio server.
 * `command`, `args`, and optional `cwd` come from acp-phone.config.json,
 * never from browser input.
 */
export async function createAcpSession({target, signal, sessionId}) {
    return createAcpStdioSession({target, signal, sessionId});
}