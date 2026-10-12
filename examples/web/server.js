import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import {createServer as createHttpsServer} from 'node:https';
import {createAcpPhoneApp} from '../../src/web/server.js';
import {loadAcpPhoneConfig, resolveConfigPath, resolveListenerSettings} from '../../src/config.js';

const directory = dirname(fileURLToPath(import.meta.url));
const argumentsAfterCommand = process.argv.slice(2).filter(argument => argument !== 'start');
const preliminaryConfigPath = resolveConfigPath({argv: argumentsAfterCommand});
dotenv.config({path: resolve(dirname(preliminaryConfigPath), '.env')});
const configPath = resolveConfigPath({argv: argumentsAfterCommand});
const config = await loadAcpPhoneConfig(configPath);
const listener = resolveListenerSettings({argv: argumentsAfterCommand, config: config.listener});
const packageMetadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const phone = createAcpPhoneApp({
    contacts: config.targets,
    environment: config.environment,
    baseDirectory: dirname(configPath),
    sessionStorePath: config.sessionStorePath,
    limits: config.limits,
    listener,
    version: packageMetadata.version,
    onProgress: logVoiceProgress,
});
const app = express();
app.use(express.static(resolve(directory, 'public'), {extensions: ['html']}));
app.use(phone.app);
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
const server = app.listen(listener.port, listener.host, () => {
    const address = server.address();
    console.log(`ACP Phone listening at http://${listener.host}:${address.port}`);
    console.log('[ACP Phone] configured ACP targets', config.targets.map(({id, label, transport}) => ({id, label, transport})));
    console.log('[ACP Phone] voice turns use automatic end-of-speech detection, then STT → streaming ACP → sentence TTS.');
});
servers.push(server);
if (tls) {
    const httpsPort = Number(setting('ACP_PHONE_HTTPS_PORT') ?? 3443);
    const httpsServer = createHttpsServer(tls, app);
    servers.push(httpsServer);
    httpsServer.listen(httpsPort, listener.host, () => {
        console.log(`ACP Phone listening at https://${listener.host}:${httpsServer.address().port}`);
    });
}

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    for (const socketServer of servers) {
        socketServer.close();
        socketServer.closeAllConnections();
    }
    try { await phone.close(); process.exit(0); }
    catch (error) { console.error('[ACP Phone] shutdown.failed', {message: error.message}); process.exit(1); }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function logVoiceProgress(event) {
    console.log(`[ACP Phone] ${event.stage}`, Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'stage')));
}
