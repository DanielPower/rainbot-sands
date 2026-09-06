import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type DrizzleTransactionLike, type Queue } from "pg-boss";
import { pgConnectionString } from "./connection.ts";

export const JOB_QUEUES = {
  transcribeSegment: "transcribe-segment",
  transcribeSegmentDead: "transcribe-segment-dead",
  advanceProcessingRun: "advance-processing-run",
  advanceProcessingRunDead: "advance-processing-run-dead",
} as const;

export interface TranscribeSegmentJob {
  jobId: string;
  sessionId: string;
  runId: string;
  segmentId: string;
}

export interface AdvanceProcessingRunJob {
  runId: string;
}

interface StartJobQueueOptions {
  worker?: boolean;
}

function processingRetryLimit(): number {
  const value = process.env.PROCESSING_MAX_ATTEMPTS;
  if (!value) return 2;
  const attempts = Number(value);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("PROCESSING_MAX_ATTEMPTS must be a positive integer");
  }
  return attempts - 1;
}

const TRANSCRIPTION_QUEUE_OPTIONS = {
  retryLimit: processingRetryLimit(),
  retryDelay: 2,
  retryBackoff: true,
  expireInSeconds: 24 * 60 * 60,
  heartbeatSeconds: 60,
  deadLetter: JOB_QUEUES.transcribeSegmentDead,
  notify: true,
} as const satisfies QueueDefinition;

const PROCESSING_QUEUE_OPTIONS = {
  retryLimit: processingRetryLimit(),
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: 24 * 60 * 60,
  heartbeatSeconds: 60,
  deadLetter: JOB_QUEUES.advanceProcessingRunDead,
  notify: true,
} as const satisfies QueueDefinition;

type QueueDefinition = Omit<Queue, "name" | "policy" | "partition">;

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;
let workerMode = false;

async function ensureQueue(
  instance: PgBoss,
  name: string,
  options: QueueDefinition = {},
  update = false,
): Promise<void> {
  await instance.createQueue(name, { policy: "standard", ...options });
  if (update && Object.keys(options).length > 0) await instance.updateQueue(name, options);
}

async function ensureQueues(instance: PgBoss): Promise<void> {
  await ensureQueue(instance, JOB_QUEUES.transcribeSegmentDead);
  await ensureQueue(instance, JOB_QUEUES.advanceProcessingRunDead);
  await ensureQueue(
    instance,
    JOB_QUEUES.transcribeSegment,
    TRANSCRIPTION_QUEUE_OPTIONS,
    workerMode,
  );
  await ensureQueue(
    instance,
    JOB_QUEUES.advanceProcessingRun,
    PROCESSING_QUEUE_OPTIONS,
    workerMode,
  );
}

export function startJobQueue(options: StartJobQueueOptions = {}): Promise<PgBoss> {
  if (starting) {
    if (options.worker && !workerMode) {
      throw new Error("The pg-boss client was already started without worker supervision");
    }
    return starting;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Missing required environment variable: DATABASE_URL");

  workerMode = options.worker ?? false;
  boss = new PgBoss({
    connectionString: pgConnectionString(connectionString),
    migrate: false,
    schedule: false,
    supervise: workerMode,
    useListenNotify: workerMode,
    max: workerMode ? 10 : 2,
  });
  boss.on("error", (error) => console.error("[pg-boss]", error));
  boss.on("warning", (warning) => console.warn("[pg-boss]", warning));

  starting = (async () => {
    await boss?.start();
    if (!boss) throw new Error("The pg-boss client stopped while it was starting");
    await ensureQueues(boss);
    return boss;
  })().catch((error) => {
    boss = null;
    starting = null;
    workerMode = false;
    throw error;
  });

  return starting;
}

export async function stopJobQueue(): Promise<void> {
  if (!starting) return;
  const instance = await starting;
  await instance.stop({ graceful: true });
  boss = null;
  starting = null;
  workerMode = false;
}

export async function enqueueJob(
  tx: DrizzleTransactionLike,
  name: typeof JOB_QUEUES.transcribeSegment,
  data: TranscribeSegmentJob,
  id: string,
): Promise<void>;
export async function enqueueJob(
  tx: DrizzleTransactionLike,
  name: typeof JOB_QUEUES.advanceProcessingRun,
  data: AdvanceProcessingRunJob,
  id: string,
): Promise<void>;
export async function enqueueJob(
  tx: DrizzleTransactionLike,
  name: string,
  data: object,
  id: string,
): Promise<void> {
  const instance = await startJobQueue();
  const jobId = await instance.send(name, data, { id, db: fromDrizzle(tx, sql) });
  if (jobId !== null && jobId !== id) {
    throw new Error(`pg-boss returned unexpected job id ${jobId} for ${id}`);
  }
}
