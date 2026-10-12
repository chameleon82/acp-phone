import {readFile} from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const version = packageJson.version;
const tag = process.env.GITHUB_REF_NAME;

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error(`package.json has an invalid semantic version: ${JSON.stringify(version)}.`);
}

if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${JSON.stringify(tag)} must exactly match package.json version v${version}.`);
}

console.log(`Release metadata verified: acp-phone@${version}${tag ? ` (${tag})` : ''}`);
