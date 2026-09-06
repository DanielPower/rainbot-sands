import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import type { SessionArtifactRef, SessionArtifactWrite } from "./artifacts.ts";
import { db } from "./client.ts";
import type { NotificationStatus, ProcessingRunKind, ProcessingRunStatus } from "./domain.ts";
import { processingRuns, sessionArtifacts, sessionSegments, sessions } from "./schema.ts";
import { JOB_QUEUES, enqueueJob, startJobQueue } from "./jobs.ts";
import { advanceTranscriptionBarrier } from "./transcription.ts";

function toArtifactRef(
  artifact: typeof sessionArtifacts.$inferSelect | undefined,
): SessionArtifactRef | null {
  if (!artifact) return null;
  return {
    id: artifact.id,
    kind: artifact.kind,
    bucket: artifact.bucket,
    objectKey: artifact.objectKey,
    contentType: artifact.contentType,
    formatVersion: artifact.formatVersion,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256,
  };
}

export interface ProcessingRunData {
  id: string;
  sessionId: string;
  campaignId: string;
  kind: ProcessingRunKind;
  status: ProcessingRunStatus;
  sourceTranscriptArtifact: SessionArtifactRef | null;
  generatedTranscriptArtifact: SessionArtifactRef | null;
  generatedDetailedRecordArtifact: SessionArtifactRef | null;
  recap: string | null;
  title: string | null;
  notificationChannelId: string | null;
  notificationStatus: NotificationStatus | null;
  startedAt: Date;
}

export async function getProcessingRun(runId: string): Promise<ProcessingRunData | null> {
  const [run] = await db
    .select({
      id: processingRuns.id,
      sessionId: processingRuns.sessionId,
      campaignId: sessions.campaignId,
      kind: processingRuns.kind,
      status: processingRuns.status,
      sourceTranscriptArtifactId: processingRuns.sourceTranscriptArtifactId,
      recap: processingRuns.recap,
      title: processingRuns.title,
      notificationChannelId: processingRuns.notificationChannelId,
      notificationStatus: processingRuns.notificationStatus,
      startedAt: sessions.startedAt,
    })
    .from(processingRuns)
    .innerJoin(sessions, eq(processingRuns.sessionId, sessions.id))
    .where(eq(processingRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const artifactPredicate = run.sourceTranscriptArtifactId
    ? or(
        eq(sessionArtifacts.generatedByRunId, run.id),
        eq(sessionArtifacts.id, run.sourceTranscriptArtifactId),
      )
    : eq(sessionArtifacts.generatedByRunId, run.id);
  const artifacts = await db.select().from(sessionArtifacts).where(artifactPredicate);

  return {
    id: run.id,
    sessionId: run.sessionId,
    campaignId: run.campaignId,
    kind: run.kind,
    status: run.status,
    sourceTranscriptArtifact: toArtifactRef(
      artifacts.find((artifact) => artifact.id === run.sourceTranscriptArtifactId),
    ),
    generatedTranscriptArtifact: toArtifactRef(
      artifacts.find(
        (artifact) => artifact.generatedByRunId === run.id && artifact.kind === "transcript",
      ),
    ),
    generatedDetailedRecordArtifact: toArtifactRef(
      artifacts.find(
        (artifact) => artifact.generatedByRunId === run.id && artifact.kind === "detailed_record",
      ),
    ),
    recap: run.recap,
    title: run.title,
    notificationChannelId: run.notificationChannelId,
    notificationStatus: run.notificationStatus,
    startedAt: run.startedAt,
  };
}

export async function storeAggregatedTranscript(
  runId: string,
  artifact: SessionArtifactWrite,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ sessionId: processingRuns.sessionId, status: processingRuns.status })
      .from(processingRuns)
      .where(eq(processingRuns.id, runId))
      .for("update");
    if (!run || run.status !== "aggregating") return false;

    await tx
      .insert(sessionArtifacts)
      .values({
        sessionId: run.sessionId,
        generatedByRunId: runId,
        kind: "transcript",
        ...artifact,
      })
      .onConflictDoUpdate({
        target: [sessionArtifacts.generatedByRunId, sessionArtifacts.kind],
        set: artifact,
      });

    const updated = await tx
      .update(processingRuns)
      .set({
        status: "summarizing",
        updatedAt: new Date(),
      })
      .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "aggregating")))
      .returning({ sessionId: processingRuns.sessionId });
    if (!updated[0]) return false;
    await tx
      .update(sessions)
      .set({ status: "summarizing" })
      .where(and(eq(sessions.id, updated[0].sessionId), eq(sessions.activeRunId, runId)));
    return true;
  });
}

export async function storeRunDetailedRecord(
  runId: string,
  artifact: SessionArtifactWrite,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ sessionId: processingRuns.sessionId, status: processingRuns.status })
      .from(processingRuns)
      .where(eq(processingRuns.id, runId))
      .for("update");
    if (!run || run.status !== "summarizing") return false;

    await tx
      .insert(sessionArtifacts)
      .values({
        sessionId: run.sessionId,
        generatedByRunId: runId,
        kind: "detailed_record",
        ...artifact,
      })
      .onConflictDoUpdate({
        target: [sessionArtifacts.generatedByRunId, sessionArtifacts.kind],
        set: artifact,
      });

    const rows = await tx
      .update(processingRuns)
      .set({
        status: "recapping",
        updatedAt: new Date(),
      })
      .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "summarizing")))
      .returning({ id: processingRuns.id });
    return rows.length > 0;
  });
}

export async function storeRunRecap(runId: string, recap: string): Promise<boolean> {
  const rows = await db
    .update(processingRuns)
    .set({ recap, status: "titling", updatedAt: new Date() })
    .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "recapping")))
    .returning({ id: processingRuns.id });
  return rows.length > 0;
}

export async function storeRunTitle(runId: string, title: string): Promise<boolean> {
  const rows = await db
    .update(processingRuns)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(processingRuns.id, runId), eq(processingRuns.status, "titling")))
    .returning({ id: processingRuns.id });
  return rows.length > 0;
}

export async function completeProcessingRun(runId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        sessionId: processingRuns.sessionId,
        status: processingRuns.status,
        recap: processingRuns.recap,
        title: processingRuns.title,
      })
      .from(processingRuns)
      .where(eq(processingRuns.id, runId))
      .for("update");
    if (!run || !["aggregating", "summarizing", "titling"].includes(run.status)) return false;

    const generatedArtifacts = await tx
      .select({ kind: sessionArtifacts.kind })
      .from(sessionArtifacts)
      .where(
        and(
          eq(sessionArtifacts.generatedByRunId, runId),
          eq(sessionArtifacts.sessionId, run.sessionId),
        ),
      );

    const updated = await tx
      .update(sessions)
      .set({
        recap: run.recap,
        title: run.title,
        status: "done",
        activeRunId: null,
      })
      .where(and(eq(sessions.id, run.sessionId), eq(sessions.activeRunId, runId)))
      .returning({ id: sessions.id });
    if (!updated[0]) return false;

    if (generatedArtifacts.length > 0) {
      await tx
        .update(sessionArtifacts)
        .set({ isCurrent: false })
        .where(
          and(
            eq(sessionArtifacts.sessionId, run.sessionId),
            inArray(
              sessionArtifacts.kind,
              generatedArtifacts.map(({ kind }) => kind),
            ),
          ),
        );
      await tx
        .update(sessionArtifacts)
        .set({ isCurrent: true })
        .where(
          and(
            eq(sessionArtifacts.generatedByRunId, runId),
            eq(sessionArtifacts.sessionId, run.sessionId),
          ),
        );
    }

    await tx
      .update(processingRuns)
      .set({
        status: "done",
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(processingRuns.id, runId));
    return true;
  });
}

export async function failProcessingRun(runId: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx
      .update(processingRuns)
      .set({ status: "failed", error: message, updatedAt: new Date(), finishedAt: new Date() })
      .where(
        and(eq(processingRuns.id, runId), notInArray(processingRuns.status, ["done", "failed"])),
      )
      .returning({ sessionId: processingRuns.sessionId });
    if (!run) return;
    await tx
      .update(sessions)
      .set({ status: "failed", activeRunId: null })
      .where(and(eq(sessions.id, run.sessionId), eq(sessions.activeRunId, runId)));
  });
}

export async function startInferenceRegeneration(sessionId: string): Promise<string> {
  await startJobQueue();
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({ activeRunId: sessions.activeRunId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update");
    if (!session) throw new Error(`Session ${sessionId} was not found`);
    if (session.activeRunId) throw new Error(`Session ${sessionId} is already being processed`);
    const [transcriptArtifact] = await tx
      .select({ id: sessionArtifacts.id })
      .from(sessionArtifacts)
      .where(
        and(
          eq(sessionArtifacts.sessionId, sessionId),
          eq(sessionArtifacts.kind, "transcript"),
          eq(sessionArtifacts.isCurrent, true),
        ),
      )
      .limit(1);
    if (!transcriptArtifact) throw new Error(`Session ${sessionId} has no transcript`);

    await tx.insert(processingRuns).values({
      id: runId,
      sessionId,
      kind: "inference",
      status: "summarizing",
      sourceTranscriptArtifactId: transcriptArtifact.id,
    });
    await tx
      .update(sessions)
      .set({ activeRunId: runId, status: "summarizing" })
      .where(eq(sessions.id, sessionId));
    await enqueueJob(tx, JOB_QUEUES.advanceProcessingRun, { runId }, runId);
  });
  return runId;
}

export async function reconcilePendingJobs(): Promise<void> {
  await startJobQueue();
  await db.transaction(async (tx) => {
    const segments = await tx
      .select({
        sessionId: sessionSegments.sessionId,
        runId: sessionSegments.transcriptionRunId,
        segmentId: sessionSegments.segmentId,
        jobId: sessionSegments.transcriptionJobId,
      })
      .from(sessionSegments)
      .innerJoin(processingRuns, eq(sessionSegments.transcriptionRunId, processingRuns.id))
      .innerJoin(sessions, eq(processingRuns.sessionId, sessions.id))
      .where(
        and(
          eq(sessionSegments.audioStatus, "ready"),
          inArray(sessionSegments.transcriptionStatus, ["pending", "processing"]),
          inArray(processingRuns.status, ["recording", "transcribing"]),
          eq(sessions.activeRunId, processingRuns.id),
        ),
      );

    for (const segment of segments) {
      if (!segment.runId) continue;
      const jobId = segment.jobId ?? randomUUID();
      if (!segment.jobId) {
        await tx
          .update(sessionSegments)
          .set({ transcriptionJobId: jobId, updatedAt: new Date() })
          .where(
            and(
              eq(sessionSegments.sessionId, segment.sessionId),
              eq(sessionSegments.segmentId, segment.segmentId),
              eq(sessionSegments.transcriptionRunId, segment.runId),
            ),
          );
      }
      await enqueueJob(
        tx,
        JOB_QUEUES.transcribeSegment,
        {
          jobId,
          sessionId: segment.sessionId,
          runId: segment.runId,
          segmentId: segment.segmentId,
        },
        jobId,
      );
    }

    const runnableRuns = await tx
      .select({ id: processingRuns.id })
      .from(processingRuns)
      .where(
        or(
          inArray(processingRuns.status, ["aggregating", "summarizing", "recapping", "titling"]),
          and(eq(processingRuns.status, "done"), eq(processingRuns.notificationStatus, "pending")),
        ),
      );
    for (const run of runnableRuns) {
      await enqueueJob(tx, JOB_QUEUES.advanceProcessingRun, { runId: run.id }, run.id);
    }

    const transcribingRuns = await tx
      .select({ id: processingRuns.id })
      .from(processingRuns)
      .where(eq(processingRuns.status, "transcribing"));
    for (const run of transcribingRuns) await advanceTranscriptionBarrier(tx, run.id);
  });
}
export async function markNotificationComplete(runId: string): Promise<void> {
  await db
    .update(processingRuns)
    .set({ notificationStatus: "completed", updatedAt: new Date() })
    .where(eq(processingRuns.id, runId));
}

export async function markNotificationFailed(runId: string, message: string): Promise<void> {
  await db
    .update(processingRuns)
    .set({ notificationStatus: "failed", error: message, updatedAt: new Date() })
    .where(eq(processingRuns.id, runId));
}
