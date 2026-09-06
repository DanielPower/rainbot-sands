import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql, type SQLWrapper } from "drizzle-orm";
import { SESSION_ARTIFACT_KINDS, type SessionArtifactKind } from "./artifacts.ts";
import {
  AUDIO_STATUSES,
  CAMPAIGN_MEMBER_ROLES,
  NOTIFICATION_STATUSES,
  PROCESSING_RUN_KINDS,
  PROCESSING_RUN_STATUSES,
  SESSION_STATUSES,
  TRANSCRIPTION_STATUSES,
  type AudioStatus,
  type CampaignMemberRole,
  type NotificationStatus,
  type ProcessingRunKind,
  type ProcessingRunStatus,
  type SessionStatus,
  type TranscriptionStatus,
} from "./domain.ts";
import type { TranscriptSegment } from "./transcript.ts";

function oneOf(column: SQLWrapper, values: readonly string[]) {
  const literals = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return sql`${column} in (${sql.raw(literals)})`;
}

export const guilds = pgTable("guilds", {
  id: varchar("id", { length: 20 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: varchar("id", { length: 20 }).primaryKey(),
  username: varchar("username", { length: 100 }).notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  guildId: varchar("guild_id", { length: 20 })
    .references(() => guilds.id)
    .notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// characterName is the player's character (null for the DM).
export const campaignMembers = pgTable(
  "campaign_members",
  {
    campaignId: uuid("campaign_id")
      .references(() => campaigns.id)
      .notNull(),
    userId: varchar("user_id", { length: 20 })
      .references(() => users.id)
      .notNull(),
    role: varchar("role", { length: 10 }).$type<CampaignMemberRole>().notNull().default("player"),
    characterName: text("character_name"),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.userId] }),
    check("campaign_members_role_check", oneOf(t.role, CAMPAIGN_MEMBER_ROLES)),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: varchar("id", { length: 30 }).primaryKey(),
    campaignId: uuid("campaign_id")
      .references(() => campaigns.id)
      .notNull(),
    guildId: varchar("guild_id", { length: 20 }),
    title: text("title"),
    channelId: varchar("channel_id", { length: 20 }).notNull(),
    sessionDir: text("session_dir").notNull(),
    activeRunId: uuid("active_run_id"),
    status: varchar("status", { length: 20 }).$type<SessionStatus>().notNull().default("recording"),
    recap: text("recap"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    index("sessions_guild_status_idx").on(t.guildId, t.status),
    index("sessions_active_run_idx").on(t.activeRunId),
    uniqueIndex("sessions_open_guild_unique")
      .on(t.guildId)
      .where(sql`${t.guildId} is not null and ${t.status} in ('recording', 'closing')`),
    check("sessions_status_check", oneOf(t.status, SESSION_STATUSES)),
  ],
);

export const processingRuns = pgTable(
  "processing_runs",
  {
    id: uuid("id").primaryKey(),
    sessionId: varchar("session_id", { length: 30 })
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    kind: varchar("kind", { length: 20 }).$type<ProcessingRunKind>().notNull(),
    status: varchar("status", { length: 20 }).$type<ProcessingRunStatus>().notNull(),
    // Only inference regeneration consumes an artifact created by another run.
    // A run's own outputs are resolved through sessionArtifacts.generatedByRunId.
    sourceTranscriptArtifactId: uuid("source_transcript_artifact_id"),
    recap: text("recap"),
    title: text("title"),
    notificationChannelId: varchar("notification_channel_id", { length: 20 }),
    notificationStatus: varchar("notification_status", { length: 20 }).$type<NotificationStatus>(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("processing_runs_status_idx").on(t.status),
    index("processing_runs_session_idx").on(t.sessionId),
    check("processing_runs_kind_check", oneOf(t.kind, PROCESSING_RUN_KINDS)),
    check("processing_runs_status_check", oneOf(t.status, PROCESSING_RUN_STATUSES)),
    check(
      "processing_runs_notification_status_check",
      oneOf(t.notificationStatus, NOTIFICATION_STATUSES),
    ),
    check(
      "processing_runs_source_transcript_kind_check",
      sql`${t.sourceTranscriptArtifactId} is null or ${t.kind} = 'inference'`,
    ),
  ],
);

// The object body lives in private S3-compatible storage. Rows retain immutable
// provenance and integrity metadata; isCurrent identifies the version published
// for a session.
export const sessionArtifacts = pgTable(
  "session_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: varchar("session_id", { length: 30 })
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    generatedByRunId: uuid("generated_by_run_id").references(() => processingRuns.id, {
      onDelete: "set null",
    }),
    kind: varchar("kind", { length: 30 }).$type<SessionArtifactKind>().notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    formatVersion: integer("format_version").default(1).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    isCurrent: boolean("is_current").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("session_artifacts_run_kind_unique").on(t.generatedByRunId, t.kind),
    uniqueIndex("session_artifacts_current_kind_unique")
      .on(t.sessionId, t.kind)
      .where(sql`${t.isCurrent} = true`),
    index("session_artifacts_session_idx").on(t.sessionId),
    check("session_artifacts_kind_check", oneOf(t.kind, SESSION_ARTIFACT_KINDS)),
  ],
);

// Audio metadata is the durable manifest for a session. Every registered clip
// has a stable key in private S3-compatible object storage.
export const sessionSegments = pgTable(
  "session_segments",
  {
    sessionId: varchar("session_id", { length: 30 })
      .references(() => sessions.id, { onDelete: "cascade" })
      .notNull(),
    segmentId: varchar("segment_id", { length: 100 }).notNull(),
    audioObjectKey: text("audio_object_key").notNull(),
    recordedAt: text("recorded_at").notNull(),
    userId: varchar("user_id", { length: 20 }).notNull(),
    username: text("username"),
    audioStatus: varchar("audio_status", { length: 20 }).$type<AudioStatus>().notNull(),
    transcriptionRunId: uuid("transcription_run_id").references(() => processingRuns.id, {
      onDelete: "set null",
    }),
    transcriptionStatus: varchar("transcription_status", {
      length: 20,
    }).$type<TranscriptionStatus>(),
    transcriptionJobId: uuid("transcription_job_id"),
    transcript: jsonb("transcript").$type<TranscriptSegment>(),
    transcribedAt: timestamp("transcribed_at"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.segmentId] }),
    index("session_segments_run_status_idx").on(t.transcriptionRunId, t.transcriptionStatus),
    index("session_segments_live_transcript_idx").on(t.sessionId, t.transcribedAt),
    index("session_segments_session_audio_idx").on(t.sessionId, t.audioStatus),
    check("session_segments_audio_status_check", oneOf(t.audioStatus, AUDIO_STATUSES)),
    check(
      "session_segments_transcription_status_check",
      oneOf(t.transcriptionStatus, TRANSCRIPTION_STATUSES),
    ),
  ],
);
