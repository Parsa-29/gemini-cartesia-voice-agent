# gemini-cartesia-voice-agent

Browser voice agent: Gemini Live (`gemini-3.8-live`) hears and thinks, Cartesia Sonic (`sonic-3.6`) speaks.
Node 22+ / TypeScript, one process on one port: HTTP + `/ws` + Vite middleware in dev.

## Commands

- Dev: `npm run dev` → http://localhost:4000
- **Verify gate (run before saying "done"):** `npm run verify` (typecheck, lint, vitest, build)
- Real end-to-end check (needs `.env` keys, costs a few cents): `npm run smoke`. Agent audio goes to `.smoke/*.wav`.

## Layout

- `src/server/session/` holds the core.
  - `VoiceSession` is transport-neutral: turn ordering, barge-in, metrics.
  - `GeminiBrain` and `CartesiaVoice` are the adapters behind the interfaces in `types.ts`.
- `src/shared/protocol.ts` is the only contract between browser and server. Change both sides together.
- `src/web/public/*-worklet.js` is plain JS served as-is, because AudioWorklets can't import bundled code. It is tested in `tests/worklets.test.ts`.
- `prompts/` holds the agent persona. Files are re-read on every call.

## Rules

- Test-first for session logic: fake Brain and Voice live in `tests/voiceSession.test.ts`, and a fake Live connector in `tests/geminiBrain.test.ts`.
- Never put API keys in the browser. `.env` stays gitignored.
- Read [docs/architecture.md](docs/architecture.md) before changing turn-taking or chunking. It records measured latencies and API quirks, such as the `voiceActivity.type` wire shape and input transcripts arriving only at the end of an utterance.
