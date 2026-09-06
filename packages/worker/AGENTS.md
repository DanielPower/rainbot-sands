# @rainbot/worker — AGENTS.md

pg-boss-backed session processing. See the root `AGENTS.md` for workspace-wide
conventions.

## Layout

- `worker.ts` — process entrypoint and graceful shutdown.
- `session-worker.ts` — registers pg-boss handlers for segment and run jobs.
- `pipeline.ts` — public recording/regeneration transitions used by Discord/web.
- `tasks.ts` — whisper and inference calls.
- `prompts.ts` / `text.ts` — shared prompts and response cleanup.
- `summarization-inference.ts` — local/OpenAI/Anthropic provider configuration.
- `scripts/evaluate-inference.ts` — standalone detailed-record pipeline harness.

## Durable state

pg-boss provides the queue in PostgreSQL; application tables remain the source
of truth for workflow state:

- `sessions.active_run_id` identifies the only run allowed to replace a session.
- `processing_runs` holds an inference run's source transcript reference and
  small recap/title output. Generated artifacts identify their run through
  `session_artifacts.generated_by_run_id`.
- `session_artifacts` holds immutable transcript/detailed-record object metadata.
- `session_segments` is the audio manifest and per-activation transcription checkpoint.
- Each ready activation has one `transcribe-segment` job. The closing barrier
  creates one `advance-processing-run` job after every activation is terminal.
- Queue messages carry stable application IDs; handlers still claim conditional
  application state before making an external request.
- Never hold a database transaction open while calling Whisper or an LLM.
- A job may expire, retry, or be redelivered. Keep transitions idempotent and
  reject stale run IDs.

Activation audio and durable session artifacts use `@rainbot/storage` with
separate private buckets. Workers never depend on a shared filesystem. Store
stable object keys in Postgres, never expiring signed URLs.

## Prompts and inference

`prompts.ts` and `text.ts` are the single source of truth shared by workers and
the standalone test harness:

```sh
pnpm --filter @rainbot/worker eval:inference <transcript.txt>
```

`TRANSCRIPTION_URL` is the complete whisper request URL.
`SUMMARIZATION_PROVIDER` selects `local`, `openai`, or `anthropic`; cloud
providers require `SUMMARIZATION_API_KEY` and `SUMMARIZATION_MODEL`. Local
summarization requires `SUMMARIZATION_BASE_URL`.
