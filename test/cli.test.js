import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/acp-phone.js', import.meta.url));

test('CLI initializes a standalone workspace and preserves existing settings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'acp-phone-cli-'));
    try {
        await run(process.execPath, [cli, 'init'], {cwd});
        const config = JSON.parse(await readFile(join(cwd, 'acp-phone.config.json'), 'utf8'));
        assert.equal(config.targets[0].command, 'codex-acp');
        assert.equal(config.targets[0].adapterModule, undefined);
        assert.match(await readFile(join(cwd, '.env'), 'utf8'), /OPENAI_BASE_URL=/);
        await writeFile(join(cwd, '.env'), 'OPENAI_API_KEY=keep-this-setting\n');
        await run(process.execPath, [cli, 'init'], {cwd});
        assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'OPENAI_API_KEY=keep-this-setting\n');
        const {stdout} = await run(process.execPath, [cli, '--help'], {cwd});
        assert.match(stdout, /acp-phone init/);
        await assert.rejects(run(process.execPath, [cli, 'unknown'], {cwd}), /Unknown command/);
    } finally {await rm(cwd, {recursive: true, force: true});}
});

test('CLI starts without .env using config defaults and respects process credentials', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'acp-phone-config-'));
    const env = {...process.env};
    for (const name of Object.keys(env)) {
        if (name.startsWith('OPENAI_') || name.startsWith('ACP_PHONE_')) delete env[name];
    }
    try {
        for (const useProcessCredentials of [false, true]) {
            await writeFile(join(cwd, 'acp-phone.config.json'), JSON.stringify({
                environment: {
                    OPENAI_API_KEY: useProcessCredentials ? '' : 'test-key',
                    OPENAI_BASE_URL: useProcessCredentials ? '' : 'http://127.0.0.1:9/v1',
                    ACP_PHONE_PORT: '0',
                },
                targets: [{id: 'test', label: 'Test', command: 'unused'}],
            }));
            const child = spawn(process.execPath, [cli], {cwd, env: {
                ...env,
                ...(useProcessCredentials ? {OPENAI_API_KEY: 'process-key', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1'} : {}),
            }, stdio: ['ignore', 'pipe', 'pipe']});
            let output = '';
            let errors = '';
            const exited = new Promise(resolve => child.once('exit', resolve));
            try {
                const url = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 30000);
                    child.stderr.on('data', chunk => {errors += chunk;});
                    child.stdout.on('data', chunk => {
                        output += chunk;
                        const match = output.match(/listening at (http:\/\/localhost:\d+)/);
                        if (match) {clearTimeout(timer); resolve(match[1]);}
                    });
                    child.once('error', error => {clearTimeout(timer); reject(error);});
                    child.once('exit', () => {clearTimeout(timer); reject(new Error(`Server exited: ${errors}`));});
                });
                const response = await fetch(`${url}/api/targets`);
                assert.equal(response.status, 200);
                assert.doesNotMatch(await response.text(), /test-key|process-key|OPENAI_API_KEY/);
                const contacts = await (await fetch(`${url}/api/contacts`)).json();
                assert.deepEqual(contacts, {contacts: [{id: 'test', label: 'Test'}]});
                for (const path of ['/', '/contacts.js', '/acp-phone.js', '/call?contact=test', '/app.js', '/pcm-capture.js', '/style.css']) {
                    const asset = await fetch(`${url}${path}`);
                    assert.equal(asset.status, 200, path);
                    if (path === '/') assert.match(await asset.text(), /contacts.js/);
                    if (path.startsWith('/call')) assert.match(await asset.text(), /id="call-view"/);
                }
            } finally {
                child.kill('SIGTERM');
                await exited;
            }
        }
    } finally {await rm(cwd, {recursive: true, force: true});}
});
