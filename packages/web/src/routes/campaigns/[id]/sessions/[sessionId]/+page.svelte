<script lang="ts">
  import { marked } from "marked";
  import type { ActionData, PageData } from "./$types";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { onMount } from "svelte";
  import TaperedRule from "$lib/components/TaperedRule.svelte";
  import LibbyChat from "$lib/components/LibbyChat.svelte";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type SessionTab = "recap" | "summary" | "transcript";
  type TranscriptTurn = NonNullable<PageData["transcriptTurns"]>[number];
  type SessionStatus = PageData["session"]["status"];
  interface LiveTranscriptSnippet extends TranscriptTurn {
    id: string;
  }

  let streamedStatus = $state<SessionStatus | null>(null);
  let liveTranscriptSnippets = $state<LiveTranscriptSnippet[]>([]);
  let sessionStatus = $derived(streamedStatus ?? data.session.status);
  let transcriptTurns = $derived(
    data.transcriptTurns?.length ? data.transcriptTurns : liveTranscriptSnippets,
  );

  function sessionTab(value: string | null): SessionTab {
    return value === "summary" || value === "transcript" ? value : "recap";
  }

  let activeTab = $derived(sessionTab(page.url.searchParams.get("tab")));

  function formatDate(d: Date | string): string {
    return new Date(d).toLocaleString("en-CA", {
      dateStyle: "long",
      timeStyle: "short",
    });
  }

  function renderMarkdown(text: string): string {
    return marked(text) as string;
  }

  function formatTranscriptTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return date.toLocaleTimeString("en-CA", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function speakerInitial(speaker: string): string {
    return speaker.trim().charAt(0).toLocaleUpperCase() || "?";
  }

  function speakerHue(userId: string): number {
    let hash = 0;
    for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return Math.abs(hash) % 360;
  }

  function transcriptSpeakers(turns: TranscriptTurn[]): TranscriptTurn[] {
    return [...new Map(turns.map((turn) => [turn.userId, turn])).values()];
  }

  function confirmRegeneration(event: SubmitEvent) {
    if (!window.confirm("Regenerate the detailed record, recap, and title from this transcript?")) {
      event.preventDefault();
    }
  }

  function confirmTranscriptRegeneration(event: SubmitEvent) {
    if (
      !window.confirm(
        "Re-transcribe every saved audio clip and regenerate the detailed record, recap, and title?",
      )
    ) {
      event.preventDefault();
    }
  }

  onMount(() => {
    if (!data.canViewDetails || ["done", "failed"].includes(data.session.status)) return;

    const source = new EventSource(
      `/campaigns/${data.session.campaignId}/sessions/${data.session.id}/transcript/events`,
    );
    source.addEventListener("snippet", (event) => {
      const snippet = JSON.parse((event as MessageEvent<string>).data) as LiveTranscriptSnippet;
      liveTranscriptSnippets = [
        ...liveTranscriptSnippets.filter((candidate) => candidate.id !== snippet.id),
        snippet,
      ].toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
    });
    source.addEventListener("status", (event) => {
      const update = JSON.parse((event as MessageEvent<string>).data) as {
        status: SessionStatus | null;
      };
      streamedStatus = update.status;
    });
    source.addEventListener("complete", (event) => {
      const update = JSON.parse((event as MessageEvent<string>).data) as {
        status: SessionStatus | null;
      };
      streamedStatus = update.status;
      source.close();
      if (update.status === "done") void invalidateAll();
    });

    return () => source.close();
  });
</script>

<svelte:head>
  <title>{data.session.title ?? formatDate(data.session.startedAt)} — Session</title>
  <meta property="og:title" content={data.preview.title}>
  <meta property="og:description" content={data.preview.description}>
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content={data.preview.title}>
  <meta name="twitter:description" content={data.preview.description}>
</svelte:head>

<p><a href="/campaigns/{data.session.campaignId}">← Campaign</a></p>

<div class="panel">
  <p class="eyebrow">A Reflection in the Mirrorways</p>
  <h1>{data.session.title ?? formatDate(data.session.startedAt)}</h1>
  {#if data.session.title}
    <p class="muted session-date">{formatDate(data.session.startedAt)}</p>
  {/if}
  <TaperedRule />
  <p class="muted status">Status: {sessionStatus}</p>

  {#if data.canViewDetails}
    {#if form?.message}
      <p class="error" role="alert">{form.message}</p>
    {/if}
    {#if page.url.searchParams.has("regenerating") || sessionStatus === "summarizing"}
      <p class="muted">Regeneration is running. Refresh this page to see its progress.</p>
    {/if}
    {#if page.url.searchParams.has("regeneratingTranscript")}
      <p class="muted">
        Transcript regeneration is running. Refresh this page to see its progress.
      </p>
    {/if}
    {#if data.canRegenerate}
      <div class="regeneration-actions">
        {#if data.hasTranscript}
          <form method="POST" action="?/regenerate" onsubmit={confirmRegeneration}>
            <button
              class="btn regenerate"
              type="submit"
              disabled={["recording", "transcribing", "summarizing"].includes(data.session.status)}
            >Regenerate inference</button>
          </form>
        {/if}
        <form
          method="POST"
          action="?/regenerateTranscript"
          onsubmit={confirmTranscriptRegeneration}
        >
          <button
            class="btn regenerate"
            type="submit"
            disabled={["recording", "transcribing", "summarizing"].includes(data.session.status)}
          >Regenerate transcript</button>
        </form>
      </div>
    {/if}

    {#if sessionStatus === "done"}
      <LibbyChat
        sessionId={data.session.id}
        campaignId={data.session.campaignId}
      />
    {:else}
      <p class="empty chat-pending">
        Libby can answer questions once this session finishes processing.
      </p>
    {/if}

    <div class="tabs" role="tablist">
      <a
        role="tab"
        href="?tab=recap"
        aria-selected={activeTab === "recap"}
        class:active={activeTab === "recap"}>Recap</a
      >
      <a
        role="tab"
        href="?tab=summary"
        aria-selected={activeTab === "summary"}
        class:active={activeTab === "summary"}>Detailed Record</a
      >
      <a
        role="tab"
        href="?tab=transcript"
        aria-selected={activeTab === "transcript"}
        class:active={activeTab === "transcript"}>Transcript</a
      >
    </div>

    <div role="tabpanel" hidden={activeTab !== "recap"}>
      {#if data.session.recap}
        <div class="prose">{@html renderMarkdown(data.session.recap)}</div>
      {:else}
        <p class="empty">The bards have not yet composed this tale.</p>
      {/if}
    </div>

    <div role="tabpanel" hidden={activeTab !== "summary"}>
      {#if data.session.detailedRecord}
        <div class="prose">{@html renderMarkdown(data.session.detailedRecord)}</div>
      {:else}
        <p class="empty">Not yet available.</p>
      {/if}
    </div>

    <div role="tabpanel" hidden={activeTab !== "transcript"}>
      {#if transcriptTurns.length}
        {@const speakers = transcriptSpeakers(transcriptTurns)}
        <section class="transcript-view" aria-label="Session transcript">
          <header class="transcript-header">
            <div>
              <p class="eyebrow">Recorded Dialogue</p>
              <h2>Table Transcript</h2>
              <p class="transcript-note">
                Machine-generated from the session audio. Names and wording may contain errors.
              </p>
            </div>
            <div class="transcript-stats" aria-label="Transcript statistics">
              <span>{transcriptTurns.length} speaker turns</span>
              <span>{speakers.length} voices</span>
            </div>
          </header>

          <div class="speaker-key" aria-label="Speakers in this transcript">
            {#each speakers as speaker (speaker.userId)}
              <span class="speaker-chip" style={`--speaker-hue: ${speakerHue(speaker.userId)}`}>
                <span class="speaker-dot" aria-hidden="true"></span>
                <strong>{speaker.speaker}</strong>
                {#if speaker.characterName}
                  <span>as {speaker.characterName}</span>
                {/if}
              </span>
            {/each}
          </div>

          <ol class="transcript-list">
            {#each transcriptTurns as turn, index (`${turn.timestamp}-${turn.userId}-${index}`)}
              <li class="transcript-turn" style={`--speaker-hue: ${speakerHue(turn.userId)}`}>
                <div class="speaker-avatar" aria-hidden="true">
                  {speakerInitial(turn.speaker)}
                </div>
                <div class="turn-content">
                  <div class="turn-meta">
                    <strong>{turn.speaker}</strong>
                    {#if turn.characterName}
                      <span class="character-name">as {turn.characterName}</span>
                    {/if}
                    <time datetime={turn.timestamp} title={formatDate(turn.timestamp)}>
                      {formatTranscriptTime(turn.timestamp)}
                    </time>
                  </div>
                  <p class="turn-text">{turn.text}</p>
                </div>
              </li>
            {/each}
          </ol>
        </section>
      {:else}
        <p class="empty">
          {sessionStatus === "recording" || sessionStatus === "closing" || sessionStatus === "transcribing"
            ? "Listening for transcription snippets…"
            : "Not yet available."}
        </p>
      {/if}
    </div>
  {:else}
    <p class="preview-description">{data.preview.description}</p>
    <p class="empty">Log in with Discord to view the complete session.</p>
    <p><a class="button" href="/auth/login">Log in with Discord</a></p>
  {/if}
</div>

<style>
  .session-date {
    margin-top: -0.5rem;
  }
  .status {
    margin-top: -0.5rem;
  }
  .preview-description {
    line-height: 1.7;
  }
  .regeneration-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.25rem 0 1rem;
  }
  .regeneration-actions form {
    margin: 0;
  }
  .regenerate:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .error {
    color: var(--accent-bright);
  }
  .tabs {
    display: flex;
    gap: 0.5rem;
    margin: 1.25rem 0 0.5rem;
    border-bottom: 1px solid var(--edge);
  }
  .tabs a {
    padding: 0.5rem 1rem;
    font-family: var(--font-display);
    font-size: 1rem;
    color: var(--ink-soft);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    text-decoration: none;
  }
  .tabs a:hover {
    color: var(--ink);
  }
  .tabs a.active {
    color: var(--gold);
    border-bottom-color: var(--gold);
  }
  .prose {
    line-height: 1.7;
  }
  .prose :global(p) {
    margin: 0.75em 0;
  }
  .prose :global(h1),
  .prose :global(h2),
  .prose :global(h3) {
    font-family: var(--font-display);
    color: var(--gold);
    margin: 1.25em 0 0.5em;
  }
  .prose :global(ul),
  .prose :global(ol) {
    padding-left: 1.5em;
    margin: 0.75em 0;
  }
  .prose :global(li) {
    margin: 0.25em 0;
  }
  .prose :global(strong) {
    color: var(--text-emphasis, var(--gold));
  }
  .prose :global(em) {
    font-style: italic;
  }
  .transcript-view {
    margin-top: 0.75rem;
    background: var(--surface-sunken);
    border: 1px solid var(--edge);
    border-radius: 4px;
    overflow: hidden;
  }
  .transcript-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 1.25rem 1.4rem;
    background: linear-gradient(135deg, var(--surface), var(--surface-sunken));
    border-bottom: 1px solid var(--edge);
  }
  .transcript-header .eyebrow {
    margin-bottom: 0.2rem;
  }
  .transcript-header h2 {
    margin: 0;
  }
  .transcript-note {
    max-width: 38rem;
    margin: 0.4rem 0 0;
    color: var(--ink-soft);
    font-size: 0.95rem;
    line-height: 1.45;
  }
  .transcript-stats {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.4rem;
    flex: 0 0 auto;
  }
  .transcript-stats span {
    padding: 0.25rem 0.55rem;
    font-family: var(--font-display);
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-soft);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
  }
  .speaker-key {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    padding: 0.8rem 1.4rem;
    background: var(--surface);
    border-bottom: 1px solid var(--edge);
  }
  .speaker-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.55rem;
    font-size: 0.82rem;
    color: var(--ink-soft);
    background: var(--surface-sunken);
    border: 1px solid var(--edge);
    border-radius: 999px;
  }
  .speaker-chip strong {
    color: var(--ink);
    font-weight: 600;
  }
  .speaker-dot {
    width: 0.55rem;
    height: 0.55rem;
    background: hsl(var(--speaker-hue) 48% 42%);
    border-radius: 50%;
  }
  .transcript-list {
    margin: 0;
    padding: 0.35rem 1.4rem;
    list-style: none;
  }
  .transcript-turn {
    display: grid;
    grid-template-columns: 2.35rem minmax(0, 1fr);
    gap: 0.85rem;
    padding: 1rem 0;
  }
  .transcript-turn + .transcript-turn {
    border-top: 1px solid color-mix(in srgb, var(--edge) 68%, transparent);
  }
  .speaker-avatar {
    display: grid;
    place-items: center;
    width: 2.35rem;
    height: 2.35rem;
    font-family: var(--font-display);
    font-size: 0.88rem;
    font-weight: 600;
    color: #fff;
    background: color-mix(in srgb, hsl(var(--speaker-hue) 48% 42%) 72%, #2b2018);
    border: 1px solid color-mix(in srgb, hsl(var(--speaker-hue) 48% 42%) 60%, var(--edge));
    border-radius: 50%;
    box-shadow: 0 1px 3px var(--shadow);
  }
  .turn-content {
    min-width: 0;
    padding-left: 0.85rem;
    border-left: 2px solid hsl(var(--speaker-hue) 42% 48%);
  }
  .turn-meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem;
    line-height: 1.2;
  }
  .turn-meta strong {
    color: var(--ink);
    font-family: var(--font-display);
    font-size: 0.92rem;
    letter-spacing: 0.015em;
  }
  .character-name {
    color: var(--gold);
    font-size: 0.9rem;
    font-style: italic;
  }
  .turn-meta time {
    margin-left: auto;
    color: var(--ink-soft);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .turn-text {
    margin: 0.38rem 0 0;
    color: var(--ink);
    font-size: 1.02rem;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    .transcript-header {
      flex-direction: column;
      gap: 0.8rem;
      padding: 1rem;
    }
    .transcript-stats {
      justify-content: flex-start;
    }
    .speaker-key {
      padding: 0.7rem 1rem;
    }
    .transcript-list {
      padding: 0.25rem 0.9rem;
    }
    .transcript-turn {
      grid-template-columns: 2rem minmax(0, 1fr);
      gap: 0.65rem;
    }
    .speaker-avatar {
      width: 2rem;
      height: 2rem;
    }
    .turn-content {
      padding-left: 0.65rem;
    }
    .turn-meta time {
      width: 100%;
      margin-left: 0;
    }
  }
</style>
