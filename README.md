# ACP Phone

A strict ECMAScript-module Node.js voice bridge for ACP agents. The web example automatically detects a caller's end of speech, transcribes the completed utterance with OpenAI STT, streams ACP text updates, synthesizes each completed response sentence with OpenAI TTS, and begins queued playback before the agent's entire response completes.

The package is deliberately reusable: the core has no HTTP/UI dependency. The included mobile web example is one integration, not the product boundary.

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

Recordings with an empty transcript, punctuation only, or an explicit noise/silence annotation are skipped before ACP is opened. The stream ends with `turn.skipped`, and the browser quietly resumes listening without generating an agent reply.

Microphone activation keeps the current agent reply playing. During an interruption, the browser transcribes an initial 800 ms preview and, if needed, a second 1.2 second preview through the configured gateway. Recognized words cancel the previous reply while recording continues; empty/noise previews keep it playing. Only the completed caller message starts the next ACP turn. Interruption timing depends on gateway transcription latency; unsupported microphone preview capture falls back to final transcription.

If the first audible response takes more than 2 seconds, the browser requests a fresh short acknowledgement based on the current caller message and available reply text. Text generation and synthesis both use the configured gateway. The prompt asks for natural wording without invented progress and includes the previous acknowledgement to discourage repetition. The cue plays at most once per turn, stops when reply audio arrives, and is cancelled on interruption, hangup, reconnect, or speaker mute. The cue shares the same initial audio buffer as the response and uses short conversational wording and streams PCM as soon as it arrives, with a slightly faster speaking rate. Text generation and first audio still take additional time; it never blocks the agent response.

## Requirements

- Node.js 20 or newer
- An OpenAI API key with access to the selected audio and text models
- A local ACP agent plus an adapter module using the ACP SDK/version that agent supports

## Run the example

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

`.env` holds secrets and selected OpenAI models. It is ignored by Git. `acp-phone.config.json` has only non-secret target configuration:

```json
{
  "limits": { "maxAudioBytes": 10485760 },
  "targets": [
    {
      "id": "local-codex",
      "label": "Local Codex Agent",
      "adapterModule": "./examples/adapters/local-acp-session.js",
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
