import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const SESSION_MODES = new Set(['create-per-call', 'reuse-target-session', 'attach-existing']);
const DEFAULT_HTTP_SESSION = Object.freeze({
    mode: 'create-per-call',
    createPath: '/acp/sessions',
    messagePathTemplate: '/acp/sessions/{sessionId}/messages',
    eventsPathTemplate: '/acp/sessions/{sessionId}/events',
});

/** Loads and validates the server-owned configuration. */
export async function loadAcpPhoneConfig(configPath) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (cause) {
        throw new Error(`Could not load ACP Phone configuration from ${configPath}: ${cause.message}`, {cause});
    }
    return normalizeAcpPhoneConfig(parsed, {configPath});
}

export function normalizeAcpPhoneConfig(config, {configPath = resolve(process.cwd(), 'acp-phone.config.json')} = {}) {
    if (!isRecord(config)) throw new TypeError('ACP Phone configuration must be a JSON object.');
    if (!Array.isArray(config.targets) || config.targets.length === 0) {
        throw new TypeError('ACP Phone configuration targets must be a non-empty array.');
    }
    const targets = config.targets.map((target, index) => normalizeTarget(target, index));
    const ids = new Set();
    for (const target of targets) {
        if (ids.has(target.id)) throw new TypeError(`ACP target IDs must be unique; duplicate ID: "${target.id}".`);
        ids.add(target.id);
    }
    if (config.environment !== undefined && !stringMap(config.environment)) {
        throw new TypeError('configuration environment must map names to strings.');
    }
    if (config.limits !== undefined && !isRecord(config.limits)) throw new TypeError('limits must be an object.');
    if (config.listener !== undefined && !isRecord(config.listener)) throw new TypeError('listener must be an object.');
    return {
        ...config,
        configPath,
        targets,
        environment: config.environment ?? {},
        listener: normalizeListenerConfig(config.listener ?? {}),
    };
}

export function resolveListenerSettings({argv = [], environment = process.env, config = {}} = {}) {
    const flags = parseListenerArgs(argv);
    const source = config.listener ?? config;
    const host = flags.host ?? environment.ACP_PHONE_HOST ?? source.host ?? '127.0.0.1';
    const port = flags.port ?? environment.ACP_PHONE_PORT ?? source.port ?? 3000;
    const publicBaseUrl = flags.publicBaseUrl ?? environment.ACP_PHONE_PUBLIC_BASE_URL ?? source.publicBaseUrl;
    return {
        host: validateHost(host),
        port: validatePort(port),
        publicBaseUrl: validatePublicBaseUrl(publicBaseUrl),
    };
}

export function resolveConfigPath({argv = [], environment = process.env, cwd = process.cwd()} = {}) {
    const flags = parseListenerArgs(argv);
    const path = flags.config ?? environment.ACP_PHONE_CONFIG ?? 'acp-phone.config.json';
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('ACP Phone config path must be a non-empty string.');
    return resolve(cwd, path);
}

export function parseListenerArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const key = {'--host': 'host', '--port': 'port', '--config': 'config', '--public-base-url': 'publicBaseUrl'}[argument];
        if (!key) throw new TypeError(`Unknown option: ${argument}.`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new TypeError(`Option ${argument} requires a value.`);
        result[key] = value;
    }
    return result;
}

function normalizeTarget(target, index) {
    if (!isRecord(target)) throw new TypeError(`targets[${index}] must be an object.`);
    if (typeof target.id !== 'string' || !target.id.trim()) throw new TypeError(`targets[${index}].id must be a non-empty string.`);
    if (typeof target.label !== 'string' || !target.label.trim()) throw new TypeError(`targets[${index}].label must be a non-empty string.`);
    const transport = target.transport ?? 'stdio';
    if (transport === 'stdio') return normalizeStdioTarget({...target, transport});
    if (transport === 'http') return normalizeHttpTarget({...target, transport});
    throw new TypeError(`ACP target "${target.id}" transport must be "stdio" or "http".`);
}

function normalizeStdioTarget(target) {
    if (typeof target.command !== 'string' || !target.command.trim()) {
        throw new TypeError(`ACP stdio target "${target.id}" must define command.`);
    }
    if (target.args !== undefined && (!Array.isArray(target.args) || target.args.some(arg => typeof arg !== 'string'))) {
        throw new TypeError(`ACP stdio target "${target.id}" args must be an array of strings.`);
    }
    if (target.cwd !== undefined && (typeof target.cwd !== 'string' || !target.cwd.trim())) {
        throw new TypeError(`ACP stdio target "${target.id}" cwd must be a non-empty string.`);
    }
    if (target.environment !== undefined && !stringMap(target.environment)) {
        throw new TypeError(`ACP stdio target "${target.id}" environment must map names to strings.`);
    }
    return target;
}

function normalizeHttpTarget(target) {
    const baseUrl = parseHttpUrl(target.baseUrl, `ACP HTTP target "${target.id}" baseUrl`);
    const sessionInput = target.session ?? {};
    if (!isRecord(sessionInput)) throw new TypeError(`ACP HTTP target "${target.id}" session must be an object.`);
    const session = {...DEFAULT_HTTP_SESSION, ...sessionInput};
    if (!SESSION_MODES.has(session.mode)) {
        throw new TypeError(`ACP HTTP target "${target.id}" session.mode is invalid.`);
    }
    for (const key of ['createPath', 'messagePathTemplate', 'eventsPathTemplate']) {
        if (typeof session[key] !== 'string' || !session[key].startsWith('/')) {
            throw new TypeError(`ACP HTTP target "${target.id}" session.${key} must be an absolute path.`);
        }
    }
    for (const key of ['messagePathTemplate', 'eventsPathTemplate', 'historyPathTemplate', 'cleanupPathTemplate']) {
        if (session[key] !== undefined && !session[key].includes('{sessionId}')) {
            throw new TypeError(`ACP HTTP target "${target.id}" session.${key} must contain {sessionId}.`);
        }
    }
    if (session.mode === 'attach-existing' && (typeof session.sessionId !== 'string' || !session.sessionId.trim())) {
        throw new TypeError(`ACP HTTP target "${target.id}" attach-existing mode requires session.sessionId.`);
    }
    if (session.createBody !== undefined && !isRecord(session.createBody)) {
        throw new TypeError(`ACP HTTP target "${target.id}" session.createBody must be a JSON object.`);
    }
    if (session.idPath !== undefined && (typeof session.idPath !== 'string' || !session.idPath.trim())) {
        throw new TypeError(`ACP HTTP target "${target.id}" session.idPath must be a non-empty dot path.`);
    }
    if (target.headers !== undefined && !stringMap(target.headers)) {
        throw new TypeError(`ACP HTTP target "${target.id}" headers must map names to strings.`);
    }
    if (target.headerEnv !== undefined && !stringMap(target.headerEnv)) {
        throw new TypeError(`ACP HTTP target "${target.id}" headerEnv must map header names to environment variable names.`);
    }
    return {...target, baseUrl: baseUrl.href.replace(/\/$/, ''), session};
}

function normalizeListenerConfig(listener) {
    const result = {};
    for (const key of ['host', 'port', 'publicBaseUrl']) if (listener[key] !== undefined) result[key] = listener[key];
    return result;
}

function parseHttpUrl(value, description) {
    let url;
    try { url = new URL(value); } catch { throw new TypeError(`${description} must be a valid HTTP(S) URL.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new TypeError(`${description} must be an HTTP(S) URL without embedded credentials.`);
    }
    return url;
}

function validatePort(value) {
    if (!/^(?:0|[1-9]\d*)$/.test(String(value))) throw new TypeError('ACP Phone port must be an integer from 1 through 65535.');
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('ACP Phone port must be an integer from 1 through 65535.');
    return port;
}

function validateHost(value) {
    if (typeof value !== 'string' || !value.trim() || /[\s/:]/.test(value)) {
        throw new TypeError('ACP Phone host must be a non-empty hostname or IP address.');
    }
    return value;
}

function validatePublicBaseUrl(value) {
    if (value === undefined || value === '') return undefined;
    return parseHttpUrl(value, 'ACP Phone public base URL').href.replace(/\/$/, '');
}

function stringMap(value) {
    return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
