# AGENTS.md

Guidance for AI agents working in this repository. Package-specific notes live in
each `packages/*/AGENTS.md`.

## What this is

**rainbot-sands** is a Discord bot that records tabletop RPG sessions, transcribes
them with whisper.cpp, and generates summaries/recaps/titles with local or cloud
models. pg-boss owns the durable queue in PostgreSQL alongside the processing
state, S3-compatible object storage holds activation audio, and a SvelteKit web
app displays results.

## Architecture / data flow

```
Discord voice ──/start──▶ Postgres session + processing run
   │  per voice activation
   │  ogg/opus clip ──▶ private S3 ──▶ pg-boss transcribe job ──▶ live snippet
   │                                                        │
   └──/stop or empty channel────────────────────────────────┘
                                                            ▼
                         aggregate ▶ detailed record ▶ recap ▶ title
                             │              │            ▼
                             └──── private artifact S3 + Postgres metadata
                                                   └──▶ SvelteKit web app
```

- The **discord** bot records audio; every activation is registered in Postgres
  before recording and uploaded after its file closes.
- The **worker** package consumes pg-boss jobs as clips become available, then
  advances post-session aggregation and inference with bounded concurrency.
- The **db** package is the single source of truth for the schema and all queries.
- The **web** app reads the same database and streams completed segment
  transcripts to active session pages with SSE.

## Monorepo layout

pnpm workspace; packages depend on each other via `workspace:*`.

| Package            | Role                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `@rainbot/db`      | Drizzle schema + Postgres client + queries                        |
| `@rainbot/discord` | Discord bot, voice recording, session recovery                    |
| `@rainbot/storage` | S3-compatible object access and artifact validation               |
| `@rainbot/worker`  | Postgres session worker: transcribe, aggregate, inference, notify |
| `@rainbot/web`     | SvelteKit frontend (Discord OAuth)                                |

## Runtime & tooling — read before writing code

- **Node.js 24 runs TypeScript natively.** There is **no build step** for `db`,
  `discord`, `storage`, and `worker` — `node` executes `.ts` files directly. Do not add
  tsx/ts-node/esbuild for these.
- **Imports must use explicit `.ts` extensions** (`./env.ts`, `../types.ts`).
  This is required by the bundler-style resolution; omitting it breaks at runtime.
- **Lint/format is oxc, not eslint/prettier:** `pnpm lint`, `pnpm lint:fix`,
  `pnpm format`, `pnpm format:fix`.
- **Typecheck a package:** `pnpm --filter @rainbot/<pkg> exec tsc --noEmit`.
  The web app uses `pnpm --filter @rainbot/web check` (svelte-check) instead.
- Match the surrounding code style; strict TS is on across the workspace.

## Common commands

```sh
pnpm install
pnpm dev                              # run all package dev scripts (recursive)
pnpm --filter @rainbot/discord dev    # one service (node --env-file --watch)
pnpm --filter @rainbot/worker dev
pnpm --filter @rainbot/web dev
pnpm --filter @rainbot/db db:generate # after editing schema.ts
pnpm --filter @rainbot/db db:migrate
```

## Environment

One **root `.env`** holds all dev variables. Dev scripts load it with
`node --env-file=../../.env`; the web app's `vite.config.ts` and drizzle config
call `loadEnvFile` on it. Each service asserts its own required vars at import
time (see each package's `env.ts` / `lib/server/env.ts`) — follow that pattern
when adding a variable. The full table is in `README.md`.

## Deployment

`docker-compose.yml` runs everything from prebuilt GHCR images. The
`.github/workflows/deploy.yml` matrix builds one image per package. `db-migrate`
runs Drizzle and pg-boss migrations before application services start. External
dependencies: PostgreSQL, S3-compatible object storage, whisper.cpp server, an optional
local/cloud language model provider, and ffmpeg (in the discord image).

## Cross-cutting conventions

- **Idempotency:** pg-boss jobs can expire, retry, or be redelivered. Conditional
  DB transitions make every processing step safe to repeat.
- **Don't commit secrets.** `.env` and `media/` are gitignored.
- **Only commit/push when asked.** If asked, branch off `main` first.
