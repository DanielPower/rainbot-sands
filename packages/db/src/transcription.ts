import { randomUUID } from "node:crypto";
import { and, asc, eq, exists, gte, inArray, isNotNull } from "drizzle-orm";
import { db, type DatabaseTransaction } from "./client.ts";
import { JOB_QUEUES, enqueueJob, startJobQueue } from "./jobs.ts";
import { evaluateTranscriptionBarrier } from "./processing-state.ts";
import { processingRuns, sessionSegments, sessions } from "./schema.ts";
import type { TranscriptSegment } from "./transcript.ts";
import type { AudioSegmentRef } from "./recording.ts";

export interface SegmentForTranscription extends AudioSegmentRef {
  sessionId: string;
  runId: string;
  jobId: string;
}

export interface LiveTranscriptSnippet {
  segmentId: string;
  runId: string;
  timestamp: string;
  userId: string;
  username?: string;
  text: string;
  transcribedAt: Date;
}

export async function claimSegmentForTranscription(
  jobId: string,
  runId: string,
  sessionId: string,
  segmentId: string,
): Promise<SegmentForTranscription | null> {
  const activeRun = db
    .select({ id: processingRuns.id })
    .from(processingRuns)
    .innerJoin(sessions, eq(processingRuns.sessionId, sessions.id))
    .where(
      and(
        eq(processingRuns.id, runId),
        eq(processingRuns.sessionId, sessionId),
        eq(sessions.activeRunId, runId),
        inArray(processingRuns.status, ["recording", "transcribing"]),
      ),
    );
  const [row] = await db
    .update(sessionSegments)
    .set({ transcriptionStatus: "processing", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(sessionSegments.sessionId, sessionId),
        eq(sessionSegments.segmentId, segmentId),
        eq(sessionSegments.transcriptionRunId, runId),
        eq(sessionSegments.transcriptionJobId, jobId),
        eq(sessionSegments.audioStatus, "ready"),
        inArray(sessionSegments.transcriptionStatus, ["pending", "processing"]),
        exists(activeRun),
      ),
    )
    .returning({
      audioObjectKey: sessionSegments.audioObjectKey,
      timestamp: sessionSegments.recordedAt,
      userId: sessionSegments.userId,
      username: sessionSegments.username,
    });

  if (!row) return null;
  return {
    sessionId,
    runId,
    jobId,
    segmentId,
    audioObjectKey: row.audioObjectKey,
    timestamp: row.timestamp,
    userId: row.userId,
    ...(row.username ? { username: row.username } : {}),
  };
}

export async function completeSegmentTranscription(
  jobId: string,
  runId: string,
  sessionId: string,
  segmentId: string,
  transcript: TranscriptSegment | null,
): Promise<void> {
  await startJobQueue();
  await db.transaction(async (tx) => {
    const completed = await tx
      .update(sessionSegments)
      .set({
        transcriptionStatus: "completed",
        transcript,
        transcribedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSegments.sessionId, sessionId),
          eq(sessionSegments.segmentId, segmentId),
          eq(sessionSegments.transcriptionRunId, runId),
          eq(sessionSegments.transcriptionJobId, jobId),
          eq(sessionSegments.transcriptionStatus, "processing"),
        ),
      )
      .returning({ segmentId: sessionSegments.segmentId });
    if (completed.length > 0) await advanceTranscriptionBarrier(tx, runId);
  });
}

export async function failSegmentTranscription(
  jobId: string,
  runId: string,
  sessionId: string,
  segmentId: string,
  message: string,
): Promise<void> {
  await startJobQueue();
  await db.transaction(async (tx) => {
    const failed = await tx
      .update(sessionSegments)
      .set({
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
          eq(sessionSegments.transcriptionJobId, jobId),
          inArray(sessionSegments.transcriptionStatus, ["pending", "processing"]),
        ),
      )
      .returning({ segmentId: sessionSegments.segmentId });
    if (failed.length > 0) await advanceTranscriptionBarrier(tx, runId);
  });
}

export async function advanceTranscriptionBarrier(
  tx: DatabaseTransaction,
  runId: string,
): Promise<boolean> {
  const [run] = await tx
    .select({ sessionId: processingRuns.sessionId, status: processingRuns.status })
    .from(processingRuns)
    .where(eq(processingRuns.id, runId))
    .for("update");
  if (!run || run.status !== "transcribing") return false;

  const segments = await tx
    .select({
      audioStatus: sessionSegments.audioStatus,
      transcriptionRunId: sessionSegments.transcriptionRunId,
      transcriptionStatus: sessionSegments.transcriptionStatus,
    })
    .from(sessionSegments)
    .where(eq(sessionSegments.sessionId, run.sessionId));

  const barrier = evaluateTranscriptionBarrier(runId, segments);
  if (barrier === "failed") {
    const message = "One or more transcription jobs failed";
    await tx
      .update(processingRuns)
      .set({ status: "failed", error: message, updatedAt: new Date(), finishedAt: new Date() })
      .where(eq(processingRuns.id, runId));
    await tx
      .update(sessions)
      .set({ status: "failed", activeRunId: null })
      .where(and(eq(sessions.id, run.sessionId), eq(sessions.activeRunId, runId)));
    return false;
  }
  if (barrier === "waiting") return false;

  const claimed = await tx
    .update(processingRuns)
    .set({ status: "aggregating", updatedAt: new Date() })
    .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "transcribing")))
    .returning({ id: processingRuns.id });
  if (!claimed[0]) return false;

  await enqueueJob(tx, JOB_QUEUES.advanceProcessingRun, { runId }, runId);
  return true;
}

export async function claimAggregationIfReady(runId: string): Promise<boolean> {
  await startJobQueue();
  return db.transaction((tx) => advanceTranscriptionBarrier(tx, runId));
}

export async function getTranscriptSegments(runId: string): Promise<TranscriptSegment[]> {
  const rows = await db
    .select({ transcript: sessionSegments.transcript })
    .from(sessionSegments)
    .where(
      and(
        eq(sessionSegments.transcriptionRunId, runId),
        eq(sessionSegments.transcriptionStatus, "completed"),
      ),
    );
  return rows
    .map((row) => row.transcript)
    .filter((segment): segment is TranscriptSegment => segment !== null)
    .toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function listLiveTranscriptSegments(
  sessionId: string,
  since?: Date,
): Promise<LiveTranscriptSnippet[]> {
  const predicates = [
    eq(sessionSegments.sessionId, sessionId),
    eq(sessionSegments.transcriptionStatus, "completed"),
    isNotNull(sessionSegments.transcript),
    isNotNull(sessionSegments.transcribedAt),
  ];
  if (since) predicates.push(gte(sessionSegments.transcribedAt, since));

  const rows = await db
    .select({
      segmentId: sessionSegments.segmentId,
      runId: sessionSegments.transcriptionRunId,
      timestamp: sessionSegments.recordedAt,
      userId: sessionSegments.userId,
      username: sessionSegments.username,
      transcript: sessionSegments.transcript,
      transcribedAt: sessionSegments.transcribedAt,
    })
    .from(sessionSegments)
    .where(and(...predicates))
    .orderBy(asc(sessionSegments.transcribedAt), asc(sessionSegments.segmentId));

  return rows.flatMap((row) => {
    if (!row.runId || !row.transcript || !row.transcribedAt) return [];
    return [
      {
        segmentId: row.segmentId,
        runId: row.runId,
        timestamp: row.timestamp,
        userId: row.userId,
        ...(row.username ? { username: row.username } : {}),
        text: row.transcript.text,
        transcribedAt: row.transcribedAt,
      },
    ];
  });
}

export async function getAudioSegmentRefs(sessionId: string): Promise<AudioSegmentRef[]> {
  return db
    .select({
      segmentId: sessionSegments.segmentId,
      audioObjectKey: sessionSegments.audioObjectKey,
      timestamp: sessionSegments.recordedAt,
      userId: sessionSegments.userId,
      username: sessionSegments.username,
    })
    .from(sessionSegments)
    .where(and(eq(sessionSegments.sessionId, sessionId), eq(sessionSegments.audioStatus, "ready")))
    .then((rows) =>
      rows.map((row) => ({
        segmentId: row.segmentId,
        audioObjectKey: row.audioObjectKey,
        timestamp: row.timestamp,
        userId: row.userId,
        ...(row.username ? { username: row.username } : {}),
      })),
    );
}

export async function startTranscriptRegeneration(
  sessionId: string,
  refs: AudioSegmentRef[],
): Promise<string> {
  await startJobQueue();
  const runId = randomUUID();
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ activeRunId: sessions.activeRunId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    if (!session) throw new Error(`Session ${sessionId} was not found`);
    if (session.activeRunId) throw new Error(`Session ${sessionId} is already being processed`);
    if (refs.length === 0) throw new Error(`Session ${sessionId} has no recorded audio metadata`);

    await tx.insert(processingRuns).values({
      id: runId,
      sessionId,
      kind: "retranscription",
      status: "transcribing",
    });

    for (const ref of refs) {
      const jobId = randomUUID();
      await tx
        .insert(sessionSegments)
        .values({
          sessionId,
          segmentId: ref.segmentId,
          audioObjectKey: ref.audioObjectKey,
          recordedAt: ref.timestamp,
          userId: ref.userId,
          username: ref.username,
          audioStatus: "ready",
          transcriptionRunId: runId,
          transcriptionStatus: "pending",
          transcriptionJobId: jobId,
        })
        .onConflictDoUpdate({
          target: [sessionSegments.sessionId, sessionSegments.segmentId],
          set: {
            audioObjectKey: ref.audioObjectKey,
            recordedAt: ref.timestamp,
            userId: ref.userId,
            username: ref.username,
            audioStatus: "ready",
            transcriptionRunId: runId,
            transcriptionStatus: "pending",
            transcriptionJobId: jobId,
            transcript: null,
            transcribedAt: null,
            error: null,
            updatedAt: new Date(),
          },
        });
      await enqueueJob(
        tx,
        JOB_QUEUES.transcribeSegment,
        { jobId, sessionId, runId, segmentId: ref.segmentId },
        jobId,
      );
    }

    await tx
      .update(sessions)
      .set({ activeRunId: runId, status: "transcribing" })
      .where(eq(sessions.id, sessionId));
    return runId;
  });
}
