import {spawn} from 'node:child_process';
import {Readable, Writable} from 'node:stream';

import {client, ndJsonStream, PROTOCOL_VERSION} from '@agentclientprotocol/sdk';

import {VoiceCallError} from '../../domain/errors.js';


/**
 * Opens one trusted local ACP stdio process for the duration of a call.
 * The process command, arguments, and working directory come only from the
 * server-side target configuration; they must never be supplied by the browser.
 */
export async function createAcpStdioSession({target, signal, sessionId}) {
    signal?.throwIfAborted();
    const child = startAcpProcess({target, command: requireCommand(target)});
    let context;
    let session;
    let release;
    let closed = false;
    const exited = new Promise((resolve) => {
        child.once('exit', resolve);
        child.once('error', resolve);
    });
    let tail = Promise.resolve();
    const lifetime = new Promise((resolve) => { release = resolve; });
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const connection = Promise.race([
        client({name: 'ACP Phone'}).connectWith(
            ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
            async (cx) => {
                context = cx;
                const initialized = await cx.request('initialize', {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: {},
                    clientInfo: {name: 'ACP Phone', version: '0.1.0'},
                });
                if (sessionId) {
                    if (!initialized.agentCapabilities?.loadSession) {
                        throw new VoiceCallError('This ACP agent does not support restoring sessions.', {
                            code: 'ACP_RESUME_UNSUPPORTED', status: 409,
                        });
                    }
                    // Attach before loading: agents may replay history during session/load.
                    session = cx.attachSession({sessionId});
                    await cx.request('session/load', {
                        sessionId, cwd: target.cwd ?? process.cwd(), mcpServers: [],
                    });
                    // Replay belongs to history, not the next voice reply.
                    session.dispose();
                    session = cx.attachSession({sessionId});
                } else {
                    session = await cx.buildSession(target.cwd ?? process.cwd()).start();
                }
                try {
                    readyResolve();
                    await lifetime;
                } finally { session.dispose(); }
            },
        ),
        onceProcessError(child, target),
    ]);
    connection.catch((error) => { readyReject(error); close(); });

    function close() {
        if (closed) return exited;
        closed = true;
        release();
        child.stdin.end();
        if (!child.killed) child.kill();
        return exited;
    }

    async function run({text, signal: turnSignal, onText}) {
        await ready;
        if (closed) throw processError(target, 'session is closed');
        turnSignal?.throwIfAborted();
        let cancelTimer;
        const cancel = () => {
            void context.notify('session/cancel', {sessionId: session.sessionId}).catch(close);
            // An unresponsive agent must not hold later turns forever.
            cancelTimer = setTimeout(close, 5000);
            cancelTimer.unref?.();
        };
        turnSignal?.addEventListener('abort', cancel, {once: true});
        const prompt = session.prompt(text);
        prompt.catch(() => {});
        let responseText = '';
        try {
            while (true) {
                const message = await session.nextUpdate();
                if (message.kind === 'stop') {
                    await prompt;
                    turnSignal?.throwIfAborted();
                    return responseText;
                }
                const chunk = agentMessageText(message.update);
                if (chunk && !turnSignal?.aborted) {
                    responseText += chunk;
                    await onText?.(chunk);
                }
            }
        } catch (cause) {
            if (!turnSignal?.aborted) close();
            throw cause;
        } finally {
            clearTimeout(cancelTimer);
            turnSignal?.removeEventListener('abort', cancel);
        }
    }

    const prompt = (options) => {
        const result = tail.then(() => run(options));
        tail = result.catch(() => {});
        return result;
    };
    try {
        await ready;
        signal?.throwIfAborted();
        return {sessionId: session.sessionId, prompt, promptStream: prompt, close,
            get isClosed() { return closed; }};
    } catch (cause) {
        close();
        if (cause instanceof VoiceCallError) throw cause;
        throw processError(target, 'could not initialize the ACP session', cause);
    }
}

function requireCommand(target) {
    if (typeof target.command !== 'string' || !target.command.trim()) {
        throw new VoiceCallError(`ACP target "${target?.id ?? 'unknown'}" must define a local command.`, {
            code: 'ACP_COMMAND_NOT_CONFIGURED',
            status: 500,
        });
    }
    if (target.args !== undefined && (!Array.isArray(target.args) || target.args.some((arg) => typeof arg !== 'string'))) {
        throw new VoiceCallError(`ACP target "${target.id}" has invalid command arguments.`, {
            code: 'ACP_COMMAND_INVALID',
            status: 500,
        });
    }
    return target.command;
}

function startAcpProcess({target, command}) {
    let child;
    try {
        child = spawn(command, target.args ?? [], {
            cwd: target.cwd ?? process.cwd(),
            // The voice server's OpenAI-compatible STT/TTS credentials must not
            // override a locally authenticated ACP agent such as Codex. Codex
            // otherwise prefers these inherited variables over its own ChatGPT
            // login and can send the voice gateway token to its model provider.
            env: acpProcessEnvironment(process.env, target),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (cause) {
        throw processError(target, `could not be started`, cause);
    }

    // Drain stderr so a noisy ACP process cannot block, but never expose its
    // potentially sensitive diagnostic output in an HTTP response.
    child.stderr.resume();
    child.once('error', (cause) => child.emit('acp-process-error', cause));
    return child;
}

function acpProcessEnvironment(environment, target) {
    const childEnvironment = {...environment};
    // Do not pass this application's speech-provider configuration into a
    // local agent process. Keep all other ambient environment variables, which
    // lets an ACP adapter retain normal PATH, HOME, and platform settings.
    delete childEnvironment.OPENAI_API_KEY;
    delete childEnvironment.OPENAI_BASE_URL;
    delete childEnvironment.OPENAI_ORG_ID;
    delete childEnvironment.OPENAI_PROJECT_ID;

    if (target.environment !== undefined) {
        if (!isEnvironmentMap(target.environment)) {
            throw new VoiceCallError(`ACP target "${target.id}" has invalid environment variables.`, {
                code: 'ACP_ENVIRONMENT_INVALID', status: 500,
            });
        }
        Object.assign(childEnvironment, target.environment);
    }
    return childEnvironment;
}

function isEnvironmentMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((entry) => typeof entry === 'string');
}

function agentMessageText(update) {
    if (update?.sessionUpdate !== 'agent_message_chunk') return '';
    const content = update.content;
    if (content?.type === 'text' && typeof content.text === 'string') return content.text;
    if (typeof content === 'string') return content;
    return '';
}

function onceProcessError(child, target) {
    return new Promise((_, reject) => {
        child.once('acp-process-error', (cause) => reject(processError(target, 'could not be started', cause)));
        child.once('exit', (code, exitSignal) => {
            if (code !== 0 && !child.killed) {
                reject(processError(target, `exited unexpectedly (${exitSignal ?? `code ${code}`})`));
            }
        });
    });
}

function processError(target, reason, cause) {
    return new VoiceCallError(`ACP target "${target.id}" ${reason}.`, {
        code: 'ACP_PROCESS_FAILED',
        status: 502,
        cause,
    });
}
