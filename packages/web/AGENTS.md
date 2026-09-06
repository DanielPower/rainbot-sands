# @rainbot/web — AGENTS.md

SvelteKit frontend (adapter-node) with Discord OAuth. Reads session metadata
from Postgres and private transcript/detailed-record objects from S3-compatible
storage; manual ingestion also writes activation audio. See the root `AGENTS.md`
for workspace-wide conventions.

## Layout

- `src/routes/` — pages + `+page.server.ts` loaders and `auth/` OAuth endpoints.
- Session transcript routes include an authenticated SSE endpoint that polls
  completed segment checkpoints and streams snippets until processing ends.
- `src/hooks.server.ts` — session cookie verification + theme injection.
- `src/lib/server/` — `env.ts`, `session.ts` (HMAC cookie), `discord.ts` (OAuth).
- `src/lib/components/`, `src/app.css`, `src/app.html`.

## Checks

`pnpm --filter @rainbot/web check` (svelte-check). This is the typecheck for this
package — plain `tsc` is not used here.

## Deployment gotcha — do not undo

adapter-node emits the app's runtime dependencies (`svelte`, `@sveltejs/kit`,
`marked`, `drizzle-orm`, `postgres`) as **bare imports in the per-route server
chunks**, so they must exist in `node_modules` at runtime — the build is _not_
fully self-contained. Consequences that are load-bearing:

- `svelte` and `@sveltejs/kit` are in **`dependencies`**, not `devDependencies`.
  They are genuine runtime deps here. Don't move them back.
- The `Dockerfile` runs `pnpm deploy --prod --legacy` to produce a portable
  `node_modules` and copies it into the runner alongside `build/`. Don't reduce
  the runner to copying only `build/` — SSR will 500 with `ERR_MODULE_NOT_FOUND`
  on the first server-rendered page (client-side nav hides it because the client
  bundle inlines the dep).

## Server env

Use `$env/dynamic/private` via `lib/server/env.ts`, guarded by the `building`
flag so assertions don't fire during `vite build`. Never import server env (or
`@rainbot/db`) into client-side code — DB access lives only in `+page.server.ts`,
`+server.ts`, and `hooks.server.ts`.

Required vars: `DATABASE_URL`, `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`,
`SESSION_SECRET`, and `ORIGIN` (SvelteKit needs it for CSRF/form-action origin
checks in production). Session chat uses `CHAT_PROVIDER` (`local`, `openai`, or
`anthropic`), with separate API key, base URL, model, and reasoning settings from
summarization. Local chat requires `CHAT_BASE_URL` and defaults to model
`qwen3.6-35b-a3b` with a `2048`-token llama.cpp thinking budget. Cloud chat
requires `CHAT_API_KEY` and `CHAT_MODEL`; it does not require any local inference
or transcription URL.

The web service needs `S3_BUCKET_AUDIO` for manual ingestion and
`S3_BUCKET_ARTIFACT` to read transcript/detailed-record tabs and session chat context.

## Notes

- Auth is a **stateless HMAC-signed session cookie** (`lib/server/session.ts`);
  there is no server-side session store.
- Theme is a cookie injected as `data-theme` on `<html>` in `hooks.server.ts` to
  avoid FOUC; the toggle sets the cookie client-side.
- Summary/recap markdown is rendered with `marked` via `{@html …}` — the content
  is model-generated (not user input).
- Live transcript delivery reads `session_segments`; it does not depend on
  pg-boss tables or job events. Keep the queue private to producers and workers.
