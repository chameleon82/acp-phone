#!/usr/bin/env node
import {readFile, copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';

const [command = 'start', ...options] = process.argv.slice(2);
try {
    if (['--help', '-h', 'help'].includes(command)) {
        console.log('ACP Phone\n\n  acp-phone init       Create configuration in the current directory\n  acp-phone [start] [options]  Start the voice app\n  acp-phone --version  Print the version\n\nListener options:\n  --host <host>\n  --port <port>\n  --config <path>\n  --public-base-url <url>\n\nCLI options override ACP_PHONE_HOST, ACP_PHONE_PORT, ACP_PHONE_CONFIG, and ACP_PHONE_PUBLIC_BASE_URL.');
    } else if (['--version', '-v'].includes(command)) {
        const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        console.log(version);
    } else if (command === 'init') {
        if (options.length) throw new Error('acp-phone init does not accept options.');
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
        console.log('Set gateway credentials in server-side environment or .env, configure ACP targets, then run acp-phone.');
    } else if (command === 'start') {
        await import('../examples/web/server.js');
    } else {
        throw new Error(`Unknown command: ${command}. Run acp-phone --help.`);
    }
} catch (error) {
    console.error(`ACP Phone: ${error.message}`);
    process.exitCode = 1;
}
