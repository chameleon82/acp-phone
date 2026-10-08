# ACP Phone — Design and Roadmap

## 1. Purpose

ACP Phone makes an AI agent reachable through a mobile-friendly, phone-call-like conversation. The first release is a **Node.js backend library** with a small configurable web example. The application accepts recorded user audio, turns it into text, sends that text to an Agent Client Protocol (ACP) session, prepares a concise spoken reply, and returns synthesized audio.

The reusable library must not depend on a specific UI, web framework, telephony provider, or ACP agent implementation. A future host application can embed it behind its existing HTTP, WebSocket, mobile-native, SIP, or PSTN interface.

## 2. First-iteration decisions

| Concern | Decision |
| --- | --- |
| Runtime | Node.js 20+ using native ECMAScript modules (`"type": "module"`). |
| Speech-to-text | OpenAI Audio Transcriptions API, default model `gpt-4o-mini-transcribe`. |
| Response preparation | OpenAI Responses API, default model `gpt-4.1-mini`; `gpt-5-nano` is a supported lower-cost configurable option. This step is optional and never substitutes for the ACP agent. |
| Text-to-speech | OpenAI Speech API, default model `gpt-4o-mini-tts`, configurable voice and output format. |
| Agent protocol | Local ACP sessions use the official `@agentclientprotocol/sdk` stable ACP v1 client over stdio. The default example target starts the locally installed `codex-acp` server; configured remote transports arrive as separate adapters. |
| Audio interaction | Browser VAD automatically detects speech/end-of-utterance. The completed utterance is uploaded to the OpenAI transcription API; ACP text deltas and sentence-level TTS audio then stream to the browser over NDJSON. |
| Example client | A no-build static mobile web UI using `MediaRecorder`, Web Audio VAD, and an ordered audio queue, served by the Node example server. It deliberately resembles a call screen without pretending to place a carrier call. |
| Secrets | `OPENAI_API_KEY` is server-only. Browser configuration never includes provider keys. |

The imported `.examples` project demonstrates useful browser audio practices—`AudioContext` must be resumed from a user gesture, audio playback must be queued, and mic permissions need careful cleanup. Its Realtime WebSocket client is intentionally **not** reused: ACP Phone prioritizes inspectable text turns, independent STT/TTS, predictable cost, and compatibility with arbitrary ACP agents.

## 3. Non-goals for iteration 1

- Native iOS/Android applications, a PWA install flow, call-kit integration, or lock-screen controls.
- Carrier telephone / PSTN calls, SIP, WebRTC media transport, and telephony-provider integration.
- Packet-level/browser-to-provider STT and TTS audio streaming. The selected OpenAI REST endpoints and the configured gateway use completed audio-file/request responses; adapters can add provider-specific realtime media later.
- A permanent conversation database, authentication/authorization, multi-user tenancy, or cloud deployment.
- Browser-to-OpenAI calls or browser storage of OpenAI API keys.
- Video/avatar functionality and OpenAI Realtime API.

A normal mobile phone UI is achievable in a browser. A literal phone-number call is not: it later requires a server-side media bridge and a telephony provider. The core library is deliberately transport-neutral so that bridge can use the same conversation service.

## 4. Architecture

```text
Mobile browser / future caller
  |  POST audio + JSON call metadata
  v
Example HTTP boundary (replaceable)
  |
  v
VoiceCallService
  |-- SpeechToTextPort.transcribe(audio)       -> transcript
  |-- AcpSessionFactory.open(target, context)  -> ACP session
  |     `-- AcpSession.prompt(transcript)      -> agent events/final text
  |-- ReplyPresenter.present(agent text)       -> spoken response text
  `-- TextToSpeechPort.synthesize(text)        -> MP3/WAV bytes
  |
  `-- transcript + agent text + spoken text + audio bytes
```

### 4.1 Package boundaries

```text
src/
  index.js                      public library exports only
  application/voice-call-service.js
  domain/                       value checks and protocol-independent types
  ports/
    speech-to-text.js
    text-to-speech.js
    reply-presenter.js
    acp-session.js
  adapters/
    openai/                     OpenAI implementations of STT, presenter, TTS
    acp/                        ACP stdio/session adapters
examples/web/                   configurable local browser app and HTTP server
```

`VoiceCallService` owns the ordered workflow and is the main embedding API. Ports are explicit JavaScript contracts, enabling a host app to replace OpenAI, ACP routing, storage, or the HTTP boundary without forking the workflow.

### 4.2 Public library API (target)

```js
import { createVoiceCallService, createOpenAiSpeechAdapters } from 'acp-phone';

const service = createVoiceCallService({
  ...createOpenAiSpeechAdapters({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL }),
  acpSessionFactory,
});

const turn = await service.handleAudioTurn({
  audio: { bytes, filename: 'turn.webm', contentType: 'audio/webm' },
  target: { id: 'local-coding-agent' },
  call: { id: 'call_123', locale: 'en' },
});
// turn contains transcript, agentText, spokenText, and audio { bytes, contentType }.
```

The final exact ACP SDK call shape will be isolated inside `acp-session.js`; application code only receives normalized text events. This avoids coupling the rest of the project to ACP SDK version changes.

### 4.3 Streaming utterance workflow

1. A caller presses Call once. The browser holds microphone permission for the call lifetime; Web Audio VAD begins a `MediaRecorder` utterance after detected speech and stops it after configurable silence.
2. The HTTP boundary validates and uploads that automatically completed audio file. OpenAI file transcription runs at this boundary; the API does not currently receive live microphone PCM in this implementation.
3. The service opens the allowed ACP session and sends the final transcript.
4. Streaming-capable ACP adapters call `onText(delta)` for every `agent_message_chunk`; the stdio adapter uses `ActiveSession.nextUpdate()` from the official SDK. Legacy adapters can supply only final `prompt()` text and fall back to a single TTS chunk.
5. The streaming HTTP endpoint emits NDJSON events: `transcript.final`, `agent.text.delta`, `tts.audio`, `turn.completed`, or `error`.
6. The service starts the opening phrase at a natural clause boundary after at least 40 characters, then detects completed sentences (with a bounded long-text fallback), calls TTS through the configured gateway, and forwards 100 ms PCM packets as they arrive. The browser schedules these packets contiguously at 24 kHz after collecting 500 ms of audio (shorter replies start when their stream completes), without waiting for a complete sentence audio file. Adapters without streaming synthesis retain completed-file playback.
7. Detected caller speech during agent output aborts the HTTP request, terminates the per-turn ACP stdio process, clears queued audio, pauses current playback, and starts a new utterance.

The default stream skips the separate reply-presenter/summarizer for incremental output; it speaks the ACP text verbatim in sentence chunks. The established `handleAudioTurn()` API preserves the original final-answer presentation/summarization flow for hosts that need it.

### 4.4 ACP integration model

An ACP target is configuration, not frontend code:

```json
{
  "targets": [
    {
      "id": "local-agent",
      "label": "Local Agent",
      "transport": "stdio",
      "command": "your-acp-agent-command",
      "args": ["--acp"]
    }
  ]
}
```

The target registry is server-side. The browser may select an allowed `id` only; it cannot provide a shell command, endpoint, or credentials.

Initial adapter responsibilities:

- start the configured ACP process with `shell: false`;
- perform ACP initialization/session setup using the chosen ACP SDK/protocol implementation;
- relay the transcript as a prompt;
- collect text updates and determine the final response;
- apply timeouts, cancellation, process cleanup, and structured error mapping.

A later `remote` adapter will use authenticated WebSocket or HTTP transport. It must implement the same `AcpSessionFactory` / `AcpSession` contract. Only verified, allow-listed endpoints may be configured.

### 4.5 OpenAI adapters

The OpenAI SDK is used exclusively from Node.js:

- **STT:** `audio.transcriptions.create({ file, model, language? })`
- **Presentation:** `responses.create({ model, input, instructions })`, only when enabled. A deterministic truncation presenter remains available for cost-sensitive/offline tests.
- **TTS:** `audio.speech.create({ model, voice, input, response_format })`

The system should default to one concise response per turn. Model and voice are configuration, not hard-coded UI choices. Provider request IDs are logged safely for diagnosis; audio, transcripts, prompts, and API keys are not logged by default.

## 5. Configuration

A `.env` file is for local development and must never be committed:

```dotenv
OPENAI_API_KEY=...
ACP_PHONE_PORT=3000
ACP_PHONE_CONFIG=./acp-phone.config.json
OPENAI_STT_MODEL=gpt-4o-mini-transcribe
OPENAI_REPLY_MODEL=gpt-4.1-mini
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=marin
```

`acp-phone.config.json` contains non-secret server configuration, target definitions, and explicit limits. Its example version is committed without real executable commands or remote credentials.

Safe initial defaults:

- 10 MiB audio request limit;
- accepted audio types: `audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/wav`;
- 60-second maximum agent-turn timeout;
- one active turn per call ID;
- a fixed, server-side allow-list of target IDs;
- CORS disabled unless configured for a known web origin.

## 6. Security and privacy requirements

1. Never expose `OPENAI_API_KEY`, ACP credentials, or target process commands to the browser.
2. Treat transcripts and agent responses as sensitive. Avoid request-body logging and retain nothing by default.
3. Authenticate callers before deployment beyond localhost. Authorization must restrict callers to permitted ACP target IDs.
4. Do not execute user-controlled commands or connect to user-supplied URLs.
5. Apply request limits, audio size/duration limits, timeouts, cancellation, and concurrency limits before enabling public access.
6. Serve production browser clients only through HTTPS. Microphone access requires a secure context except localhost.
7. Notify callers that OpenAI and the selected ACP agent receive conversational content; obtain appropriate consent before recording or telephony use.

## 7. Quality attributes and observability

- **Correctness:** preserve the full ACP text response in metadata even when the spoken rendition is concise.
- **Latency:** report STT, ACP, presentation, and TTS durations individually.
- **Resilience:** fail one stage with a typed public error without exposing provider internals or secrets.
- **Testability:** all provider and ACP dependencies are injected; unit tests use fake ports and no network/API keys.
- **Accessibility:** the example UI has labels, keyboard controls, text transcript/status, and no audio-only state.
- **Cost control:** configurable models, one presentation request per turn at most, character/audio limits, and no Realtime session by default.

## 8. Roadmap

### Milestone 0 — Foundation (complete)

- [x] Strict Node.js ESM package metadata, lint-free imports, tests, and `.env.example`.
- [x] `DESIGN.md` as the durable architecture and delivery record.
- [x] Server-side target configuration and safe allow-listed target registry.

### Milestone 1 — Runnable local voice turn (complete for `codex-acp`)

- [x] OpenAI STT and TTS adapters.
- [x] Configurable concise-reply presenter using mini/nano-capable text models.
- [x] Normalized ACP session port and ACP v1 stdio adapter using the official SDK.
- [x] `VoiceCallService` orchestration and typed errors.
- [x] Static mobile call-screen example: record → upload → transcript/status → play reply.
- [x] Unit tests for orchestration/boundary validation and a live local `codex-acp` protocol verification.

**Exit criteria:** with an OpenAI key, a locally authenticated Codex installation, and `codex-acp` on `PATH`, a user can press Call, speak one turn, receive agent speech, and read the transcript in the browser.

### Milestone 2 — Conversation quality (in progress)

- [x] Session reuse and conversation/call lifecycle, prompt cancellation, and idle cleanup.
- [x] Browser end-of-speech detection, cancellation/barge-in, and ordered client playback queue.
- [x] ACP text chunk collection and sentence-chunk TTS, without requiring Realtime.
- [ ] Provider-level streaming STT/TTS adapters and partial transcript forwarding when the selected gateway supports them.
- [ ] Configurable locale, model/voice profiles, context windows, and opt-in transcript retention.

### Milestone 3 — Product hardening

- [ ] Authentication, target-level authorization, encrypted secrets, audit-safe telemetry, and rate limits.
- [ ] Docker deployment, health/readiness endpoints, structured logging, and metrics.
- [ ] OpenAPI contract and a framework adapter (Express/Fastify/Hono selected after integration requirements are known).
- [ ] Remote ACP adapter with authenticated, allow-listed endpoints.

### Milestone 4 — Real call transports

- [ ] WebRTC/mobile-native integration.
- [ ] Telephony provider adapter for inbound/outbound PSTN or SIP.
- [ ] Bidirectional streaming audio bridge, barge-in, call recording consent, regional privacy controls, and operational monitoring.

## 9. Open questions deferred safely

- Which ACP SDK/version and exact local agent executable should be first-class defaults? The initial code will keep this behind an adapter and provide an explicit configuration seam.
- Should conversations survive process restarts? Active calls retain an in-memory ACP session; conversation history does not survive a server restart.
- What authentication system should hosts use? The core must accept caller identity/authorization context but not choose an identity provider.
- Which telephony vendor is desired? This is a later adapter decision, not a core design decision.

## 10. Change log

- **2025-02-02:** Initial design. Chose separate OpenAI STT, text presentation, and TTS APIs over Realtime API for the first iteration; Node.js ESM core; ACP adapter boundary; local browser call-screen example.
- **2026-10-08:** Added browser VAD, NDJSON streaming transport, ACP v1 `agent_message_chunk` forwarding, sentence-level TTS/playback queue, and speech barge-in cancellation. Documented the retained completed-utterance STT and per-sentence REST TTS boundaries.
