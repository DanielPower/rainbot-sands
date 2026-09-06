DROP INDEX "processing_runs_queue_idx";--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "transcription_job_id" uuid;--> statement-breakpoint
ALTER TABLE "session_segments" ADD COLUMN "transcribed_at" timestamp;--> statement-breakpoint
UPDATE "session_segments" SET "transcribed_at" = "updated_at" WHERE "transcription_status" = 'completed';--> statement-breakpoint
CREATE INDEX "session_segments_live_transcript_idx" ON "session_segments" USING btree ("session_id","transcribed_at");--> statement-breakpoint
ALTER TABLE "processing_runs" DROP COLUMN "available_at";--> statement-breakpoint
ALTER TABLE "processing_runs" DROP COLUMN "locked_by";--> statement-breakpoint
ALTER TABLE "processing_runs" DROP COLUMN "lease_expires_at";--> statement-breakpoint
ALTER TABLE "processing_runs" DROP COLUMN "attempt_count";
