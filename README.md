# rainbot-sands

Discord bot that records tabletop RPG sessions, transcribes them with
whisper.cpp, and generates detailed records and recaps with local or cloud
language models. pg-boss provides a durable queue in PostgreSQL alongside the
pipeline state, while S3-compatible object storage holds activation audio and
generated session artifacts.

## Packages

| Package            | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `@rainbot/discord` | Discord bot — joins voice channels and records audio                 |
| `@rainbot/storage` | S3-compatible object access and artifact validation                  |
| `@rainbot/worker`  | pg-boss worker — transcription, aggregation, inference, notification |
| `@rainbot/db`      | Drizzle schema, pg-boss client, and durable processing state         |
| `@rainbot/web`     | SvelteKit frontend                                                   |

## Requirements

- Node.js 24
- pnpm
- ffmpeg (for the Discord bot)
- PostgreSQL
- S3-compatible object storage
- whisper.cpp server
- A local or cloud language model provider

## Setup

```sh
pnpm install
```

Create a root `.env` and fill in the values needed by the services you run.

Run database migrations:

```sh
pnpm --filter @rainbot/db db:migrate
```

## Development

```sh
pnpm --filter @rainbot/discord dev
pnpm --filter @rainbot/worker dev
pnpm --filter @rainbot/web dev
```

## Environment variables

Service names below match `docker-compose.yml`; `db-migrate` is the
`@rainbot/db` migration image.

### Core and authentication

| Variable                                            | Used by                          | Description                                                                      |
| --------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | postgres, Docker Compose         | Creates PostgreSQL and constructs container `DATABASE_URL` values                |
| `DATABASE_URL`                                      | db-migrate, discord, worker, web | PostgreSQL connection string                                                     |
| `DISCORD_TOKEN`                                     | discord, worker                  | Bot token; worker uses it to post completed-session links                        |
| `DISCORD_APPLICATION_ID`                            | discord, web                     | Discord application ID for commands and OAuth                                    |
| `DISCORD_CLIENT_SECRET`                             | web                              | Discord OAuth client secret                                                      |
| `SESSION_SECRET`                                    | web                              | Secret used to sign login sessions                                               |
| `ORIGIN`                                            | web, Docker Compose              | Public web origin; Compose also passes it to worker as `WEB_URL`                 |
| `WEB_URL`                                           | worker                           | Public web origin used in completed-session links; required when running locally |
| `BODY_SIZE_LIMIT`                                   | web                              | Maximum manual-upload request size; Compose defaults it to `10G`                 |

### Audio and processing

| Variable                    | Used by              | Description                                                                     |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `S3_ACCESS_KEY_ID`          | discord, worker, web | Optional static access key; omit both credentials to use the AWS provider chain |
| `S3_BUCKET_ARTIFACT`        | worker, web          | Private bucket for durable transcripts and detailed records                     |
| `S3_BUCKET_AUDIO`           | discord, worker, web | Private, short-lived activation-audio bucket; web uses it for manual uploads    |
| `S3_ENDPOINT`               | discord, worker, web | Optional shared S3-compatible endpoint; omit for AWS S3                         |
| `S3_FORCE_PATH_STYLE`       | discord, worker, web | Set to `true` when the storage provider requires path-style requests            |
| `S3_REGION`                 | discord, worker, web | Object-storage region                                                           |
| `S3_SECRET_ACCESS_KEY`      | discord, worker, web | Optional static secret; must be set with the access key                         |
| `TRANSCRIPTION_URL`         | worker               | Complete transcription endpoint, such as `http://whisper-server:8080/inference` |
| `TRANSCRIPTION_MODEL`       | worker               | Transcription model ID (default: `whisper-large-v3-turbo`)                      |
| `TRANSCRIPTION_CONCURRENCY` | worker               | Simultaneous activation transcriptions (default: `4`)                           |
| `PROCESSING_CONCURRENCY`    | worker               | Sessions processed concurrently by one worker (default: `2`)                    |
| `PROCESSING_MAX_ATTEMPTS`   | worker               | Maximum attempts for a session or activation before failure (default: `3`)      |

### Language-model inference

| Variable                         | Used by | Description                                                                                         |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `SUMMARIZATION_PROVIDER`         | worker  | Detailed record, recap, and title provider: `local`, `openai`, or `anthropic` (default: `local`)    |
| `SUMMARIZATION_API_KEY`          | worker  | Required for OpenAI and Anthropic; optional for local                                               |
| `SUMMARIZATION_BASE_URL`         | worker  | Required for local; optional OpenAI or Anthropic endpoint override                                  |
| `SUMMARIZATION_MODEL`            | worker  | Required for cloud providers; local default: `qwen3.6-35b-a3b`                                      |
| `SUMMARIZATION_REASONING_EFFORT` | worker  | Optional cloud effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`; `minimal` is OpenAI-only |
| `SUMMARIZATION_THINKING_BUDGET`  | worker  | Local llama.cpp reasoning budget (default: `8192`)                                                  |
| `CHAT_PROVIDER`                  | web     | Session-chat provider: `local`, `openai`, or `anthropic` (default: `local`)                         |
| `CHAT_API_KEY`                   | web     | Required for OpenAI and Anthropic; optional for local                                               |
| `CHAT_BASE_URL`                  | web     | Required for local; optional OpenAI or Anthropic endpoint override                                  |
| `CHAT_MODEL`                     | web     | Required for cloud providers; local default: `qwen3.6-35b-a3b`                                      |
| `CHAT_REASONING_EFFORT`          | web     | Optional cloud effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max`; `minimal` is OpenAI-only |
| `CHAT_THINKING_BUDGET`           | web     | Local llama.cpp reasoning budget (default: `2048`)                                                  |

Keep both buckets private. Transcript and detailed-record objects share the
artifact bucket under separate session/run prefixes; recap and title stay in
Postgres for fast page listings and URL previews. Configure an audio-bucket
lifecycle expiration as the provider-enforced retention boundary. Retain audio
for as long as transcript regeneration should remain available; the application
stores stable object keys and does not depend on signed URLs. Recorder and
manual-upload scratch files use each service's local temporary
directory and are removed after upload; no shared filesystem is required.
The web service needs artifact read access; the worker needs read/write access.

Summarization and chat use independent provider profiles. Local thinking budgets
accept `0` to disable thinking, a positive token limit, or `-1` for unlimited.
Cloud providers use their corresponding reasoning-effort setting.
