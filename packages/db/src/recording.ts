import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./client.ts";
import {
  RECOVERABLE_SESSION_STATUSES,
  type AudioStatus,
  type RecoverableSessionStatus,
} from "./domain.ts";
import { processingRuns, sessionSegments, sessions } from "./schema.ts";
import { JOB_QUEUES, enqueueJob, startJobQueue } from "./jobs.ts";
import { advanceTranscriptionBarrier } from "./transcription.ts";

export interface AudioSegmentRef {
  segmentId: string;
  audioObjectKey: string;
  timestamp: string;
  userId: string;
  username?: string;
}

export interface CreateRecordingSessionInput {
  id: string;
  campaignId: string;
  guildId?: string;
  channelId: string;
  notificationChannelId?: string;
  sessionDir: string;
}

export async function createRecordingSession(input: CreateRecordingSessionInput): Promise<string> {
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: input.id,
      campaignId: input.campaignId,
      guildId: input.guildId,
      channelId: input.channelId,
      sessionDir: input.sessionDir,
      activeRunId: runId,
      status: "recording",
    });
    await tx.insert(processingRuns).values({
      id: runId,
      sessionId: input.id,
      kind: "recording",
      status: "recording",
      notificationChannelId: input.notificationChannelId,
      notificationStatus: input.notificationChannelId ? "pending" : null,
    });
  });
  return runId;
}

export interface RecoverableSession {
  id: string;
  channelId: string;
  sessionDir: string;
  runId: string;
  status: RecoverableSessionStatus;
}

export async function getRecoverableSessionsForGuild(
  guildId: string,
): Promise<RecoverableSession[]> {
  const rows = await db
    .select({
      id: sessions.id,
      channelId: sessions.channelId,
      sessionDir: sessions.sessionDir,
      runId: sessions.activeRunId,
      status: sessions.status,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.guildId, guildId),
        inArray(sessions.status, [...RECOVERABLE_SESSION_STATUSES]),
      ),
    );

  return rows.flatMap((row) => {
    if (row.runId === null || (row.status !== "recording" && row.status !== "closing")) {
      return [];
    }
    return [{ ...row, runId: row.runId, status: row.status }];
  });
}

export async function hasOpenRecordingForGuild(guildId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.guildId, guildId),
        inArray(sessions.status, [...RECOVERABLE_SESSION_STATUSES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function registerRecordingSegment(
  sessionId: string,
  runId: string,
  ref: AudioSegmentRef,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ status: sessions.status, activeRunId: sessions.activeRunId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    if (!session || session.status !== "recording" || session.activeRunId !== runId) {
      throw new Error(`Session ${sessionId} is no longer accepting audio segments`);
    }

    await tx
      .insert(sessionSegments)
      .values({
        sessionId,
        segmentId: ref.segmentId,
        audioObjectKey: ref.audioObjectKey,
        recordedAt: ref.timestamp,
        userId: ref.userId,
        username: ref.username,
        audioStatus: "recording",
        transcriptionRunId: runId,
      })
      .onConflictDoNothing();
  });
}

export async function markSegmentReady(
  sessionId: string,
  runId: string,
  segmentId: string,
): Promise<void> {
  await startJobQueue();
  const jobId = randomUUID();
  await db.transaction(async (tx) => {
    const ready = await tx
      .update(sessionSegments)
      .set({
        audioStatus: "ready",
        transcriptionStatus: "pending",
        transcriptionJobId: jobId,
        transcript: null,
        transcribedAt: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSegments.sessionId, sessionId),
          eq(sessionSegments.segmentId, segmentId),
          eq(sessionSegments.transcriptionRunId, runId),
          eq(sessionSegments.audioStatus, "recording"),
        ),
      )
      .returning({ segmentId: sessionSegments.segmentId });
    if (!ready[0]) return;
    await enqueueJob(
      tx,
      JOB_QUEUES.transcribeSegment,
      { jobId, sessionId, runId, segmentId },
      jobId,
    );
  });
}

export async function markSegmentAudioFailed(
  sessionId: string,
  runId: string,
  segmentId: string,
  message: string,
): Promise<void> {
  await db
    .update(sessionSegments)
    .set({
      audioStatus: "failed",
      transcriptionStatus: "failed",
      transcribedAt: new Date(),
      error: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionSegments.sessionId, sessionId),
        eq(sessionSegments.segmentId, segmentId),
        eq(sessionSegments.transcriptionRunId, runId),
      ),
    );
}

export async function markSegmentDiscarded(
  sessionId: string,
  runId: string,
  segmentId: string,
  reason?: string,
): Promise<void> {
  await db
    .update(sessionSegments)
    .set({
      audioStatus: "discarded",
      transcriptionStatus: null,
      transcript: null,
      error: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionSegments.sessionId, sessionId),
        eq(sessionSegments.segmentId, segmentId),
        eq(sessionSegments.transcriptionRunId, runId),
      ),
    );
}

export async function beginClosingSession(sessionId: string, runId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ status: "closing" })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.activeRunId, runId),
        eq(sessions.status, "recording"),
      ),
    );
}

export async function finishClosingSession(sessionId: string, runId: string): Promise<void> {
  await startJobQueue();
  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({ status: "transcribing", endedAt: new Date() })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.activeRunId, runId),
          eq(sessions.status, "closing"),
        ),
      );
    await tx
      .update(processingRuns)
      .set({ status: "transcribing", updatedAt: new Date() })
      .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "recording")));

    const [failedSegment] = await tx
      .select({ segmentId: sessionSegments.segmentId })
      .from(sessionSegments)
      .where(
        and(
          eq(sessionSegments.sessionId, sessionId),
          eq(sessionSegments.transcriptionRunId, runId),
          eq(sessionSegments.transcriptionStatus, "failed"),
        ),
      )
      .limit(1);
    if (failedSegment) {
      const message = `Transcription failed for segment ${failedSegment.segmentId}`;
      await tx
        .update(processingRuns)
        .set({
          status: "failed",
          error: message,
          updatedAt: new Date(),
          finishedAt: new Date(),
        })
        .where(eq(processingRuns.id, runId));
      await tx
        .update(sessions)
        .set({ status: "failed", activeRunId: null })
        .where(and(eq(sessions.id, sessionId), eq(sessions.activeRunId, runId)));
      return;
    }

    await advanceTranscriptionBarrier(tx, runId);
  });
}
export async function getAudioSegmentsForRecovery(sessionId: string): Promise<
  (AudioSegmentRef & {
    audioStatus: AudioStatus;
    runId: string | null;
  })[]
> {
  const rows = await db
    .select({
      segmentId: sessionSegments.segmentId,
      audioObjectKey: sessionSegments.audioObjectKey,
      timestamp: sessionSegments.recordedAt,
      userId: sessionSegments.userId,
      username: sessionSegments.username,
      audioStatus: sessionSegments.audioStatus,
      runId: sessionSegments.transcriptionRunId,
    })
    .from(sessionSegments)
    .where(
      and(
        eq(sessionSegments.sessionId, sessionId),
        inArray(sessionSegments.audioStatus, ["recording", "ready"]),
      ),
    );
  return rows.map((row) => ({
    segmentId: row.segmentId,
    audioObjectKey: row.audioObjectKey,
    timestamp: row.timestamp,
    userId: row.userId,
    ...(row.username ? { username: row.username } : {}),
    audioStatus: row.audioStatus,
    runId: row.runId,
  }));
}
