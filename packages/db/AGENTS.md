# @rainbot/db — AGENTS.md

Drizzle ORM schema, Postgres client, and all shared queries. See the root
`AGENTS.md` for workspace-wide conventions.

## Layout

- `schema.ts` — table definitions; the single source of truth for the data model.
- `client.ts` — the `db` instance.
- `domain.ts` — shared literal values and types for persisted roles and states.
- `campaigns.ts` — campaign/member mutations.
- `queries.ts` — read queries used by web and workers.
  `getCampaignAccess` resolves admin/member access in one database query.
- `recording.ts` — recording lifecycle, clip registration, and crash recovery.
- `transcription.ts` — segment transcription checkpoints and aggregation barrier.
- `processing-runs.ts` — inference state, publication, and queue reconciliation.
- `jobs.ts` — lazy pg-boss lifecycle, queue definitions, and transactional sends.
- `artifacts.ts` — shared metadata types for durable session objects.
- `transcript.ts` — the `Transcript`/`TranscriptSegment` JSON shape stored in
  transcript artifacts, plus display and inference formatting transforms.
- `index.ts` — the package's **public API**. Export anything other packages need
  from here; consumers import from `@rainbot/db`, never deep paths.

## The client is lazily initialized — keep it that way

`client.ts` is a `Proxy` that defers reading `DATABASE_URL` until the first query.
This is deliberate: the web app imports `@rainbot/db` at build time, and reading
the env var at module load would break `vite build` (where `DATABASE_URL` is
absent). **Do not read `DATABASE_URL` at import time** or add top-level DB
connections.

## Migrations

Workflow after any change to `schema.ts`:

```sh
pnpm --filter @rainbot/db db:generate   # writes drizzle/NNNN_*.sql + updates meta/
pnpm --filter @rainbot/db db:migrate    # applies to the DB in DATABASE_URL
```

- Migrations are **forward-only and append-only**. Never edit or delete a
  migration that has been committed or applied — add a new one.
- `drizzle/meta/_journal.json` and the snapshot files must stay in sync with the
  `.sql` files. Let `drizzle-kit` manage them; don't hand-edit. (If you must
  discard an _uncommitted, never-applied_ migration, delete its `.sql` +
  snapshot and revert the journal entry, then regenerate.)
- In production, the `db-migrate` compose service runs `db:migrate` on deploy;
  this applies both Drizzle application migrations and pg-boss schema migrations.

## Data model notes

- `session_artifacts` stores versioned S3 object metadata for transcripts and
  detailed records. `is_current` is switched atomically when a processing run
  publishes, so failed regeneration leaves old results intact. Recap/title stay
  on `sessions` for fast listings and previews.
- A transcript artifact is JSON typed as `Transcript` (see `transcript.ts`):
  every recorded segment, lossless (timestamp, userId, username, text,
  whisper's own per-segment metadata). LLM-facing formatting prepends the cast
  legend but omits timestamp strings to reduce context usage. It happens in
  `formatTranscriptForInference`, not at write time — so improving that
  formatting later can be re-run over already-recorded sessions without
  re-transcribing. Both it and the display-oriented
  `formatTranscriptForDisplay` use Whisper's own `segments[]` (verbatim under
  `TranscriptSegment.whisper`) to explode each Discord voice activation into
  finer-grained per-utterance timestamps, which preserve chronological ordering
  despite background noise keeping an activation open long after someone
  stopped talking. Both formats drop individual sub-segments Whisper itself
  flags as noise — the pattern to extend for future formatting improvements.
- `campaign_members` has `role` (`dm` | `player`) and `characterName` (null for
  the DM). The cast legend and player management depend on these.
- `users.is_admin` grants application-wide visibility into every campaign and
  is managed manually.
- A ready audio segment and its `transcribe-segment` job are committed in the
  same transaction. Completing the last segment after session close advances
  the run and enqueues its `advance-processing-run` job atomically.
- Processing writes use conditional transitions so expired or redelivered
  pg-boss jobs are safe.
