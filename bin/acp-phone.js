#!/usr/bin/env node
import {readFile, copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';

const command = process.argv[2] ?? 'start';
try {
    if (process.argv.length > 3) throw new Error('Unexpected arguments. Run acp-phone --help.');
    if (['--help', '-h', 'help'].includes(command)) {
        console.log('ACP Phone\n\n  acp-phone init       Create configuration in the current directory\n  acp-phone [start]    Start the voice app\n  acp-phone --version  Print the version\n\nSet OPENAI_API_KEY and OPENAI_BASE_URL in your environment, optional .env, or configuration environment, then open http://localhost:3000.');
    } else if (['--version', '-v'].includes(command)) {
        const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(version);
    } else if (command === 'init') {
        for (const [source, name, mode] of [['.env.example', '.env', 0o600], ['acp-phone.config.example.json', 'acp-phone.config.json', 0o644]]) {
            const destination = resolve(process.cwd(), name);
            try {
                await copyFile(new URL(`../${source}`, import.meta.url), destination, constants.COPYFILE_EXCL);
                const {chmod} = await import('node:fs/promises');
                await chmod(destination, mode);
                console.log(`Created ${name}`);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                console.log(`Kept existing ${name}`);
            }
        }
        console.log('Set your gateway URL and key in your environment, optional .env, or configuration environment, configure your ACP agents, then run npx acp-phone.');
    } else if (command === 'start') {
        await import('../examples/web/server.js');
    } else {
        throw new Error(`Unknown command: ${command}. Run acp-phone --help.`);
    }
} catch (error) {
    console.error(`ACP Phone: ${error.message}`);
    process.exitCode = 1;
}
