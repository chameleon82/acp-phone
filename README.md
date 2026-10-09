# ACP Phone

A strict ECMAScript-module Node.js voice bridge for ACP agents. The web example automatically detects a caller's end of speech, transcribes the completed utterance with OpenAI STT, streams ACP text updates, synthesizes each completed response sentence with OpenAI TTS, and begins queued playback before the agent's entire response completes.

The package is deliberately reusable: the core has no HTTP/UI dependency. Separate server and browser entry points provide the complete embeddable call UI. The web example supplies a contacts page and demonstrates how to host the module.

## Status

Milestone 2's first low-latency slice is runnable with the locally detected `codex-acp` adapter. The example target `local-codex` starts that adapter over stdio, negotiates stable ACP v1 through the official ACP TypeScript SDK, and forwards `agent_message_chunk` updates as soon as Codex emits them.

The browser receives only target `id` and `label`; the executable command, arguments, working directory, and all credentials remain server-side. Read [DESIGN.md](./DESIGN.md) for architecture, security constraints, package contract, and the delivery roadmap.

## Low-latency call behavior

1. Tap **Call** once and grant microphone permission. The browser keeps the microphone open for the duration of the call.
2. Browser voice-activity detection starts a recording after speech is detected, including a 350 ms audio buffer before detection so the first syllable is retained, and submits it after approximately 850 ms of silence. There is no Pause-to-send control; **Mic on/off** is only an optional privacy mute.
3. The current OpenAI transcription endpoint is a completed-audio-file API, so transcription begins immediately at the automatic speech boundary—not continuously from raw microphone packets.
4. ACP `agent_message_chunk` updates are forwarded through an NDJSON HTTP stream. The opening phrase can start TTS at a comma, colon, or semicolon after at least 40 characters; subsequent chunks use completed sentences. All TTS requests use the configured gateway. PCM audio arrives in 100 ms pieces and starts playing before the whole sentence has been synthesized. The browser schedules adjacent packets on its audio clock after buffering 500 ms of actual audio to protect the opening syllables from network jitter; shorter replies flush when their stream completes.
5. Start speaking while the agent is talking to cancel the in-flight browser request, current ACP prompt, queued audio, and current playback, then begin a new utterance.

Each call keeps one ACP session across turns, so follow-up questions retain conversational context. Hanging up closes the session; abandoned sessions expire after 15 minutes of inactivity. Audio plays through the Web Audio context activated by the Call button.

The streaming path reads PCM directly from the Speech API response through the configured gateway. It uses the existing REST endpoint and does not require Realtime API support. Final user messages still use completed-recording transcription.

Each manually connected call generates a fresh natural Russian greeting of one or two words, then synthesizes it through the configured gateway and existing audio queue. The previous greeting is supplied to encourage variation. Reconnects do not repeat it. The greeting does not create an ACP turn and is discarded if the caller starts speaking before it arrives or the call ends.

A separate contacts screen lists configured ACP agents. Clicking a contact selects that agent, saves the selection, and immediately starts its call. A dedicated call screen contains the avatar, call activity, audio controls, and Call Notes. Hangup returns to contacts; automatic reconnect stays on the call screen.

Dialing lasts at least two seconds, even when connection setup succeeds immediately. After one second, a local outgoing ring repeats until the session and microphone are ready. It stops at connection success, before greeting generation finishes.

Pressing End releases the microphone and cancels the agent immediately, plays a short local descending tone when the speaker is enabled, and keeps the ended call visible for two seconds before returning to contacts. Page cleanup and connection failures skip this confirmation.

Recordings with an empty transcript, punctuation only, or an explicit noise/silence annotation are skipped before ACP is opened. The stream ends with `turn.skipped`, and the browser quietly resumes listening without generating an agent reply.

Microphone activation keeps the current agent reply playing. During an interruption, the browser transcribes an initial 800 ms preview and, if needed, a second 1.2 second preview through the configured gateway. Recognized words cancel the previous reply while recording continues; empty/noise previews keep it playing. Only the completed caller message starts the next ACP turn. Interruption timing depends on gateway transcription latency; unsupported microphone preview capture falls back to final transcription.

If the first audible response takes more than 1 second, the browser requests a fresh short acknowledgement based on the current caller message and available reply text. Text generation and synthesis both use the configured gateway. The prompt asks for natural wording without invented progress and includes the previous acknowledgement to discourage repetition. The model may omit a cue for a simple greeting or acknowledgement. During long tasks, further cues are prepared after roughly 25 seconds without fresh agent output, using the latest available message. Cues never overlap agent playback, stop as soon as new nonempty agent text arrives, before reply audio, and is cancelled on interruption, hangup, reconnect, or speaker mute. The cue shares the same initial audio buffer as the response and uses short conversational wording and streams PCM as soon as it arrives, with a slightly faster speaking rate. Text generation and first audio still take additional time; it never blocks the agent response.

## Requirements

- Node.js 20 or newer
- An OpenAI API key with access to the selected audio and text models
- A local ACP agent supporting the stable ACP v1 protocol over stdio

## Install and run the app

After the npm release is published:

```sh
mkdir my-acp-phone
cd my-acp-phone
npx acp-phone init
# Edit .env: set OPENAI_BASE_URL to your gateway and OPENAI_API_KEY.
# Install your ACP agents separately: codex-acp and claude-agent-acp on PATH.
npx acp-phone
```

Or install globally with `npm install -g acp-phone` and run `acp-phone init` followed by `acp-phone`.
The app reads `.env` and `acp-phone.config.json` from your current directory. Existing files are kept by `init`.
Session history is saved under `.acp-phone` alongside the configuration. Set `ACP_PHONE_CONFIG` to use another configuration file; relative agent paths are resolved from that file's directory. ACP Phone connects to the configured command using its built-in stdio implementation. No adapter setting or separate adapter file is needed. Run `acp-phone --help` for commands.

## Run from source

```sh
npm install
cp .env.example .env
cp acp-phone.config.example.json acp-phone.config.json
# Edit .env and set OPENAI_API_KEY.
# This repository's default target requires codex-acp on PATH.
npm start
```

Then open `http://localhost:3000` on the machine running the server. For a physical phone, expose the development server through trusted HTTPS (for example, a secure tunnel); microphone access is restricted to secure contexts except localhost.

Run checks and unit tests:

```sh
npm run check
npm test
```

## Configuration

`.env` is optional. Set gateway credentials and selected OpenAI models in the process environment, `.env`, or a top-level `environment` object in `acp-phone.config.json`. Process environment takes priority over `.env`, which takes priority over configuration defaults. Agents inherit these values; a target's own `environment` can override them for that agent. Values are literal strings; `${VARIABLE}` substitution is not supported.

For example, add this alongside `targets` to configure the app without `.env`:

```json
"environment": {
  "OPENAI_API_KEY": "your-gateway-key",
  "OPENAI_BASE_URL": "https://gateway.example/v1"
}
```

Keep configuration containing credentials out of version control. A complete target configuration looks like:

```json
{
  "limits": { "maxAudioBytes": 10485760 },
  "targets": [
    {
      "id": "local-codex",
      "label": "Local Codex Agent",
      "command": "codex-acp",
      "args": [],
      "cwd": "."
    }
  ]
}
```

The browser receives only `id` and `label`; it never receives a command, endpoint, ACP credential, or OpenAI key. `local-codex` uses the authentication, sandbox, and approval policy already configured for your local Codex installation. Treat spoken prompts as untrusted input: keep this local example private and use a restrictive Codex policy/workspace before exposing it beyond your own machine.

## ACP adapter contract

An adapter module is server-side ESM and must export:

```js
export async function createAcpSession({ target, call, signal }) {
  // Initialize/connect using your ACP SDK here.
  return {
    async prompt({ text, call, signal }) {
      // Fallback: return final agent text.
      return 'Final ACP agent reply';
    },
    async promptStream({ text, call, signal, onText }) {
      // Preferred: call onText(delta) for each agent text delta, then return final text.
      onText('First response fragment. ');
      return 'First response fragment.';
    },
    async close() {
      // End or release the ACP session.
    },
  };
}
```

This small normalized boundary isolates ACP SDK churn and supports local stdio sessions now as well as remote ACP transports later. Never accept adapter paths, shell commands, arbitrary URLs, or credentials from the browser.

## Embedding the core

### Embed the call screen in your own app

First mount the server module inside your own Express application. Importing it does not start a listener, read configuration files, load `.env`, or register process signal handlers. Your app supplies the contacts and gateway configuration:

```js
import express from 'express';
import {createAcpPhoneApp} from 'acp-phone/server';

const app = express();
const phone = createAcpPhoneApp({
  contacts: [
    {id: 'codex', label: 'Codex', command: 'codex-acp', cwd: '.'},
    {id: 'claude', label: 'Claude', command: 'claude-agent-acp', cwd: '.'},
  ],
  speech: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  },
});
app.use('/phone', phone.app);
app.listen(3000);
// During your application's shutdown, await phone.close() to release ACP sessions.
```

The module serves its API and call assets beneath the mount path. It does not serve the example's contacts page. `baseDirectory` defaults to the host process's working directory; agent paths and `sessionStorePath` are relative to it. The default session store is `.acp-phone/sessions.json`; pass `sessionStorePath: false` to disable disk persistence. Optional `environment` defaults are inherited by agents and used for speech settings, with process environment taking priority. Per-contact `environment` overrides affect that agent. Explicit `speech` settings override speech defaults.

The browser entry point exposes contacts and a call screen independently of the example's contacts page:

```js
import {createAcpPhone} from 'acp-phone/browser';

const phone = createAcpPhone({baseUrl: '/phone/'});
const contacts = await phone.getContacts(); // [{id, label}]; no commands or secrets

callIcon.addEventListener('click', () => {
  phone.openCall(contacts[0].id, {
    onEnd: () => callIcon.focus(),
  });
});
```

`openCall(contactId)` synchronously opens a modal containing the built-in call screen and starts connecting to that contact without showing a contact list. It returns `{close()}` to end the call from the host app. Only one call can be open per client instance. Hangup retains the existing completion sound and then closes the modal. Conversation IDs stay separate for each contact and survive later calls.

Choose the call appearance with `skin`: `default` retains the original ACP Phone design, `telegram` uses a blue call screen, `whatsapp` uses a green call screen, and `matrix` shows subdued green monospaced call notes behind the call controls. Default notes appear in their panel; Telegram and WhatsApp hide them. Matrix notes follow the latest text automatically. These are independent designs inspired by those apps and the Matrix aesthetic. All skins use the same call lifecycle and audio behavior.

```js
const phone = createAcpPhone({baseUrl: '/phone/', skin: 'telegram'});
callIcon.onclick = () => phone.openCall('claude');
// Override the default for a particular call:
otherCallIcon.onclick = () => phone.openCall('codex', {skin: 'whatsapp'});
```

`ACP_PHONE_SKINS`, exported from `acp-phone/browser`, lists available `{id, label}` values. Unknown API skin names are rejected. Direct call links also accept `?contact=CONTACT_ID&skin=telegram`; unknown URL skin names fall back to `default`. The example's appearance selector saves the chosen skin locally for future calls. In Matrix, text remains still during speech and falls into a continuous green rain after the final response audio finishes. Existing rain persists during new text and interruptions; new replies appear above it and join its columns after playback. Reduced-motion preferences keep text still.

For an unbundled browser app, import `createAcpPhone` from `/phone/acp-phone.js` when mounted at `/phone`. A separate ACP Phone server also works by passing its URL as `baseUrl`. Calling the contacts API from another origin requires the host deployment to configure CORS; embedded microphone access requires HTTPS (or localhost) and a Permissions Policy allowing the phone origin. No new authentication scheme is provided by this browser client. Hosts can mount their existing authentication middleware before `phone.app`.

The call screen is available directly at `/phone/call?contact=CONTACT_ID` when mounted at `/phone`. Unknown contacts show an error and do not open an agent session.

### Use the conversation service directly

```js
import {
  createConfiguredAcpSessionFactory,
  createOpenAiSpeechAdapters,
  VoiceCallService,
} from 'acp-phone';

const speech = createOpenAiSpeechAdapters({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});
const service = new VoiceCallService({
  ...speech,
  acpSessionFactory: createConfiguredAcpSessionFactory({ targets }),
});

const result = await service.handleAudioTurn({
  audio: { bytes, filename: 'turn.webm', contentType: 'audio/webm' },
  target: { id: 'local-agent' },
  call: { id: 'call_123', locale: 'en' },
});
```

`result` includes the complete transcript, raw ACP text, spoken rendition, synthesized bytes, content type, and per-stage timings. Keep transcripts/audio out of logs unless the caller has consented to retention.

## Why not Realtime API first?

The supplied avatar example uses a browser Realtime WebSocket. ACP Phone instead uses server-side STT → ACP → sentence TTS stages. This keeps OpenAI credentials server-side, makes the ACP exchange inspectable, supports cheap model choices for non-streaming rewriting/summarization, and lets any future web, native, WebRTC, SIP, or PSTN boundary reuse the same core. The current streaming path avoids waiting for the whole ACP response, while retaining a transparent completed-utterance STT boundary.

## Security

This local example is not production-ready authentication. Before remote deployment, add caller authentication and target authorization, HTTPS, rate/concurrency limits, strict CORS, consent/retention policy, safe logs, and process/agent isolation. A browser-like call screen is not a carrier phone call; PSTN/SIP requires a separate server-side telephony media adapter.


Conversation recovery: the web client remembers one conversation per agent in
localStorage. Call again to continue it, including after a network interruption
or browser restart. Calls always continue the saved conversation for that agent. Closing the page
stops local audio without deleting the server session.
The selected agent is restored too. Before enabling the microphone, Call
opens or reloads the server session; connection failures keep the conversation
ID so you can retry. During an active call, network failures switch to
**Reconnecting…** and automatically retry restoring that same conversation
every 1–5 seconds. The microphone stays open; listening resumes when restoration
succeeds. A health check every five seconds also detects server restarts while
you are silent. Ending the call cancels retries. An interrupted reply is not
automatically replayed or resubmitted.

The server saves the mapping between call IDs and ACP session IDs in
`.acp-phone/sessions.json` (override with `sessionStorePath` in the configuration).
After hangup, idle expiry, or server restart, it restores the conversation using
ACP `session/load`. The agent must support `loadSession` and retain its history;
unsupported or failed loads report an error instead of silently starting over.
Custom adapters receive `sessionId` in `createAcpSession` and should return their
session ID alongside `prompt` and `close` to enable recovery after process exit.
Browser storage and the server mapping must both be retained for recovery.

Call notes show interim text during long utterances. The browser sends complete
four-second WAV previews, with a short overlap to preserve words at boundaries,
to the same transcription service through the configured gateway. Preview
requests run one at a time and use additional transcription capacity. After your
pause, the full recording is transcribed and its final text replaces the preview.
Only the final voice turn goes to the ACP agent.

All speech requests use the same `OPENAI_API_KEY` and required `OPENAI_BASE_URL`.
The server does not fall back to the official OpenAI endpoint. If previews fail,
the call continues and text appears after the pause.
