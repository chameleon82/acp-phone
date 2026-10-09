import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/acp-phone.js', import.meta.url));

test('CLI initializes a standalone workspace and preserves existing settings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'acp-phone-cli-'));
    try {
        await run(process.execPath, [cli, 'init'], {cwd});
        const config = JSON.parse(await readFile(join(cwd, 'acp-phone.config.json'), 'utf8'));
        assert.equal(config.targets[0].adapterModule, 'stdio');
        assert.match(await readFile(join(cwd, '.env'), 'utf8'), /OPENAI_BASE_URL=/);
        await writeFile(join(cwd, '.env'), 'OPENAI_API_KEY=keep-this-setting\n');
        await run(process.execPath, [cli, 'init'], {cwd});
        assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'OPENAI_API_KEY=keep-this-setting\n');
        const {stdout} = await run(process.execPath, [cli, '--help'], {cwd});
        assert.match(stdout, /acp-phone init/);
        await assert.rejects(run(process.execPath, [cli, 'unknown'], {cwd}), /Unknown command/);
    } finally {await rm(cwd, {recursive: true, force: true});}
});
