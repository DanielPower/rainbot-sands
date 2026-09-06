# @rainbot/discord — AGENTS.md

The Discord bot: slash commands, voice recording, and crash recovery. See the
root `AGENTS.md` for workspace-wide conventions.

## Layout

- `index.ts` — entrypoint: register commands, start the bot, recover sessions.
- `discord.ts` — client setup, command registry, interaction routing.
- `commands/` — one module per slash command.
- `session.ts` — voice join, per-activation recording, workflow signalling.
- `recording.ts` — in-memory `activeSessions` map (keyed by guildId).
- `recovery.ts` — rejoin/resume running sessions after a restart.
- `env.ts` — asserts Discord and S3-compatible storage configuration.

## Commands

A command module is `{ data: SlashCommandBuilder, handler, autocomplete? }`.
To add one:

1. Create `commands/<name>.ts`.
2. Add it to the `commands` object in `discord.ts`. **The object key must equal
   the command's name** — routing does `commands[interaction.commandName]`. For
   hyphenated names use a quoted key, e.g. `"add-player": addPlayer`.
3. Commands **re-register on every startup** via `registerCommands()`; no manual
   deploy step.

Campaign selection uses the shared `commands/autocomplete.ts` helper; DM-only
management commands use `commands/guard.ts` (`requireDmOfCampaign`).

## Recording

- Gateway intents: `Guilds` and `GuildVoiceStates` (voice state cache is how we
  find the caller's channel and resolve usernames).
- Each voice activation is registered in Postgres before recording, becomes one
  ogg/opus clip via **ffmpeg**, and is uploaded to S3-compatible object storage.
- Marking an upload ready enqueues its pg-boss transcription job in the same
  transaction, so the worker can transcribe while the session is still active.
- Session shutdown first stops new activations, then finalizes all active
  receiver/decoder/ffmpeg pipelines before closing the durable session. The
  close transition and transcription barrier then enqueue post-session work
  when every activation is terminal. Keep this ordering so speech in progress
  during `/stop` or auto-end is retained.
- The transcript speaker label is the **account username** resolved from the
  guild member cache (`session.ts`), falling back to the user id. It is joined to
  campaign members by `userId` downstream, so keep the id flowing through.

## State & recovery

On startup, `recoverSessions()` queries Postgres for recording/closing sessions,
repairs clips interrupted by a crash, and either rejoins the voice channel or
finishes shutdown. Segment IDs must remain globally unique so a restarted bot
cannot overwrite clips from the previous process.
