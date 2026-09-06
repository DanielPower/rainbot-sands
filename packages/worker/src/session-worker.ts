import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JOB_QUEUES,
  claimAggregationIfReady,
  claimSegmentForTranscription,
  completeProcessingRun,
  completeSegmentTranscription,
  failProcessingRun,
  failSegmentTranscription,
  getProcessingRun,
  getTranscriptSegments,
  markNotificationComplete,
  markNotificationFailed,
  reconcilePendingJobs,
  startJobQueue,
  stopJobQueue,
  storeAggregatedTranscript,
  storeRunDetailedRecord,
  storeRunRecap,
  storeRunTitle,
  type AdvanceProcessingRunJob,
  type ProcessingRunData,
  type SessionArtifactKind,
  type SegmentForTranscription,
  type Transcript,
  type TranscribeSegmentJob,
} from "@rainbot/db";
import {
  ArtifactIntegrityError,
  artifactContentHash,
  artifactObjectKey,
  getArtifactStorage,
  getAudioStorage,
  loadDetailedRecordArtifact,
  loadTranscriptArtifact,
} from "@rainbot/storage";
import { UnrecoverableTaskError } from "./errors.ts";
import { postSessionLink } from "./notify.ts";
import { generateTitle, recap, summarize, transcribeSegment } from "./tasks.ts";

const PROCESSING_CONCURRENCY = positiveInteger("PROCESSING_CONCURRENCY", 2);
const TRANSCRIPTION_CONCURRENCY = positiveInteger("TRANSCRIPTION_CONCURRENCY", 4);

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: Error): string {
  return error.stack || error.message;
}

async function noCleanup(): Promise<void> {}

async function uploadSessionArtifact(
  campaignId: string,
  sessionId: string,
  runId: string,
  kind: SessionArtifactKind,
  body: string,
  contentType: string,
) {
  return getArtifactStorage().uploadArtifact(
    artifactObjectKey(campaignId, sessionId, runId, kind, artifactContentHash(body)),
    body,
    contentType,
  );
}

async function materializeAudio(
  segment: SegmentForTranscription,
): Promise<{ audioPath: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "rainbot-audio-"));
  const extension = path.extname(segment.audioObjectKey) || ".ogg";
  const audioPath = path.join(directory, `${segment.segmentId}${extension}`);
  try {
    await getAudioStorage().downloadFile(segment.audioObjectKey, audioPath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    audioPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function transcribeOne(
  jobId: string,
  payload: TranscribeSegmentJob,
  signal?: AbortSignal,
): Promise<void> {
  if (payload.jobId !== jobId) {
    throw new UnrecoverableTaskError(`Transcription job id mismatch: ${jobId}`);
  }
  const segment = await claimSegmentForTranscription(
    jobId,
    payload.runId,
    payload.sessionId,
    payload.segmentId,
  );
  if (!segment) return;

  let cleanup: () => Promise<void> = noCleanup;
  try {
    const materialized = await materializeAudio(segment);
    cleanup = materialized.cleanup;
    const transcript = await transcribeSegment(materialized.audioPath, segment, signal);
    await completeSegmentTranscription(
      jobId,
      segment.runId,
      segment.sessionId,
      segment.segmentId,
      transcript,
    );
  } catch (error) {
    const failure = asError(error);
    if (failure instanceof UnrecoverableTaskError) {
      await failSegmentTranscription(
        jobId,
        segment.runId,
        segment.sessionId,
        segment.segmentId,
        errorMessage(failure),
      );
      return;
    }
    throw failure;
  } finally {
    await cleanup();
  }
}

async function aggregateRun(run: ProcessingRunData): Promise<void> {
  const transcript: Transcript = {
    version: 1,
    segments: await getTranscriptSegments(run.id),
  };
  const artifact = await uploadSessionArtifact(
    run.campaignId,
    run.sessionId,
    run.id,
    "transcript",
    JSON.stringify(transcript),
    "application/json",
  );
  if (!(await storeAggregatedTranscript(run.id, artifact))) return;
  if (transcript.segments.length === 0) await completeProcessingRun(run.id);
}

async function readTranscript(run: ProcessingRunData): Promise<Transcript> {
  const artifact =
    run.kind === "inference" ? run.sourceTranscriptArtifact : run.generatedTranscriptArtifact;
  if (!artifact) throw new UnrecoverableTaskError(`Run ${run.id} has no transcript artifact`);
  return loadTranscriptArtifact(artifact);
}

async function readDetailedRecord(run: ProcessingRunData): Promise<string> {
  if (!run.generatedDetailedRecordArtifact) {
    throw new UnrecoverableTaskError(`Run ${run.id} has no detailed record artifact`);
  }
  return loadDetailedRecordArtifact(run.generatedDetailedRecordArtifact);
}

async function processCurrentStage(run: ProcessingRunData): Promise<void> {
  switch (run.status) {
    case "transcribing":
      await claimAggregationIfReady(run.id);
      return;
    case "aggregating":
      await aggregateRun(run);
      return;
    case "summarizing": {
      const detailedRecord = await summarize(await readTranscript(run), run.campaignId);
      const artifact = await uploadSessionArtifact(
        run.campaignId,
        run.sessionId,
        run.id,
        "detailed_record",
        detailedRecord,
        "text/markdown; charset=utf-8",
      );
      await storeRunDetailedRecord(run.id, artifact);
      return;
    }
    case "recapping":
      await storeRunRecap(run.id, await recap(await readDetailedRecord(run)));
      return;
    case "titling":
      if (!run.recap) throw new UnrecoverableTaskError(`Run ${run.id} has no recap`);
      if (await storeRunTitle(run.id, await generateTitle(run.recap))) {
        await completeProcessingRun(run.id);
      }
      return;
    case "done":
      if (run.notificationStatus === "pending" && run.notificationChannelId) {
        try {
          await postSessionLink({
            channelId: run.notificationChannelId,
            campaignId: run.campaignId,
            sessionId: run.sessionId,
          });
          await markNotificationComplete(run.id);
        } catch (error) {
          await markNotificationFailed(run.id, errorMessage(asError(error)));
        }
      }
      return;
  }
}

async function processRun(payload: AdvanceProcessingRunJob): Promise<void> {
  try {
    while (true) {
      const run = await getProcessingRun(payload.runId);
      if (!run || run.status === "failed") return;
      if (run.status === "transcribing") {
        await claimAggregationIfReady(run.id);
        return;
      }
      await processCurrentStage(run);
      if (run.status === "done") return;
    }
  } catch (error) {
    const failure = asError(error);
    if (failure instanceof UnrecoverableTaskError || failure instanceof ArtifactIntegrityError) {
      await failProcessingRun(payload.runId, errorMessage(failure));
      return;
    }
    throw failure;
  }
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export async function runSessionWorker(signal: AbortSignal): Promise<void> {
  const boss = await startJobQueue({ worker: true });

  await boss.work<TranscribeSegmentJob>(
    JOB_QUEUES.transcribeSegment,
    { localConcurrency: TRANSCRIPTION_CONCURRENCY },
    async ([job]) => {
      if (job) await transcribeOne(job.id, job.data, job.signal);
    },
  );
  await boss.work<AdvanceProcessingRunJob>(
    JOB_QUEUES.advanceProcessingRun,
    { localConcurrency: PROCESSING_CONCURRENCY },
    async ([job]) => {
      if (job) await processRun(job.data);
    },
  );
  await boss.work<TranscribeSegmentJob>(JOB_QUEUES.transcribeSegmentDead, async ([job]) => {
    if (!job) return;
    await failSegmentTranscription(
      job.data.jobId,
      job.data.runId,
      job.data.sessionId,
      job.data.segmentId,
      "Transcription exhausted its retry limit",
    );
  });
  await boss.work<AdvanceProcessingRunJob>(JOB_QUEUES.advanceProcessingRunDead, async ([job]) => {
    if (job) await failProcessingRun(job.data.runId, "Processing exhausted its retry limit");
  });

  await reconcilePendingJobs();
  console.log("[worker] pg-boss workers started");
  await abortPromise(signal);
  await stopJobQueue();
  console.log("[worker] pg-boss workers stopped");
}
