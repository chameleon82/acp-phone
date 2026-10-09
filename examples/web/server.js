import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import {createServer as createHttpsServer} from 'node:https';
import {createAcpPhoneApp} from '../../src/web/server.js';

dotenv.config();
const directory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.cwd(), process.env.ACP_PHONE_CONFIG ?? 'acp-phone.config.json');
const config = await loadConfig(configPath);
const phone = createAcpPhoneApp({
    contacts: config.targets,
    environment: config.environment,
    baseDirectory: dirname(configPath),
    sessionStorePath: config.sessionStorePath,
    limits: config.limits,
    onProgress: logVoiceProgress,
});
const app = express();
app.use(express.static(resolve(directory, 'public'), {extensions: ['html']}));
app.use(phone.app);
const port = Number(process.env.ACP_PHONE_PORT ?? config.environment?.ACP_PHONE_PORT ?? 3000);
const setting = name => process.env[name] ?? config.environment?.[name];
const certPath = setting('ACP_PHONE_TLS_CERT');
const keyPath = setting('ACP_PHONE_TLS_KEY');
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both ACP_PHONE_TLS_CERT and ACP_PHONE_TLS_KEY.');
let tls;
try {
    tls = {
        cert: await readFile(resolve(dirname(configPath), certPath ?? '.acp-phone/tls/cert.pem')),
        key: await readFile(resolve(dirname(configPath), keyPath ?? '.acp-phone/tls/key.pem')),
    };
} catch (error) {
    if (certPath || keyPath || error.code !== 'ENOENT') throw error;
}
const servers = [];
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`ACP Phone listening at http://localhost:${server.address().port}`);
    console.log('[ACP Phone] configured ACP targets', config.targets.map(({id, label, command, cwd}) => ({id, label, command, cwd})));
    console.log('[ACP Phone] voice turns use automatic end-of-speech detection, then STT → streaming ACP → sentence TTS.');
});
servers.push(server);
if (tls) {
    const httpsPort = Number(setting('ACP_PHONE_HTTPS_PORT') ?? 3443);
    const httpsServer = createHttpsServer(tls, app);
    servers.push(httpsServer);
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
        console.log(`ACP Phone listening at https://localhost:${httpsServer.address().port}`);
    });
}

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    for (const listener of servers) {
        listener.close();
        listener.closeAllConnections();
    }
    try {
        await phone.close();
        process.exit(0);
    } catch (error) {
        console.error('[ACP Phone] shutdown.failed', {message: error.message});
        process.exit(1);
    }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function logVoiceProgress(event) {
    console.log(`[ACP Phone] ${event.stage}`, Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== 'stage'),
    ));
}

async function loadConfig(path) {
    try {
        const config = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(config.targets) || config.targets.length === 0) {
            throw new Error('targets must be a non-empty array');
        }
        return config;
    } catch (cause) {
        throw new Error(`Could not load ACP Phone configuration from ${path}: ${cause.message}`, {cause});
    }
}
