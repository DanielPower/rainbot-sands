import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { APICallError } from "ai";
import { UnrecoverableTaskError } from "./errors.ts";
import { SUMMARIZATION_CONFIG, TRANSCRIPTION_MODEL, TRANSCRIPTION_URL } from "./env.ts";
import { TITLE_SYSTEM } from "./prompts.ts";
import { stripCodeFence, normalizeTitle } from "./text.ts";
import { createDetailedRecord, createRecap } from "./record-pipeline.ts";
import { createSummarizationInference } from "./summarization-inference.ts";
import {
  formatTranscriptForInference,
  getCampaignCast,
  type AudioSegmentRef,
  type Transcript,
  type TranscriptSegment,
} from "@rainbot/db";

interface WhisperResponse {
  text: string;
  segments: { no_speech_prob: number; avg_logprob?: number }[];
}

const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1;
const completeSummarization = createSummarizationInference(SUMMARIZATION_CONFIG);

function audioMimeType(audioPath: string): string {
  switch (path.extname(audioPath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/ogg";
  }
}

// ── Transcription ─────────────────────────────────────────────────────────────

export async function transcribeSegment(
  audioPath: string,
  ref: AudioSegmentRef,
  signal?: AbortSignal,
): Promise<TranscriptSegment | null> {
  if (!existsSync(audioPath)) {
    throw new UnrecoverableTaskError(`Audio file not found for segment ${ref.segmentId}`);
  }
  const form = new FormData();
  // Put the routing field first so OpenAI-compatible proxies can select a
  // backend before consuming the potentially large file part.
  form.append("model", TRANSCRIPTION_MODEL);
  form.append(
    "file",
    new Blob([new Uint8Array(readFileSync(audioPath))], {
      type: audioMimeType(audioPath),
    }),
    path.basename(audioPath),
  );
  form.append("temperature", "0.0");
  form.append("temperature_inc", "0.2");
  form.append("no_speech_thold", String(NO_SPEECH_THRESHOLD));
  form.append("response_format", "verbose_json");

  const res = await fetch(TRANSCRIPTION_URL, {
    method: "POST",
    body: form,
    signal,
  });

  if (!res.ok) {
    const responseBody = (await res.text()).trim();
    const detail = responseBody ? `: ${responseBody}` : "";
    const message = `Transcription server returned ${res.status} ${res.statusText} for model ${TRANSCRIPTION_MODEL}${detail}`;
    if (res.status >= 400 && res.status < 500) {
      throw new UnrecoverableTaskError(message);
    }
    throw new Error(message);
  }

  const result = (await res.json()) as WhisperResponse;

  // A long imported track contains intentionally silent intervals. Whisper
  // considers a sub-segment silent only when no-speech probability is high and
  // decoded-token confidence is low. no_speech_prob alone can be high for
  // confidently decoded speech.
  const noSpeechProb =
    result.segments.length > 0 ? Math.min(...result.segments.map((s) => s.no_speech_prob)) : 1;
  const hasSpeech = result.segments.some(
    (segment) =>
      segment.no_speech_prob <= NO_SPEECH_THRESHOLD ||
      (segment.avg_logprob !== undefined && segment.avg_logprob >= LOGPROB_THRESHOLD),
  );

  if (!hasSpeech) {
    console.log(
      `[transcribe] skipping segment ${ref.segmentId} (no_speech_prob=${noSpeechProb.toFixed(2)})`,
    );
    return null;
  }

  const text = result.text.trim();
  if (!text) return null;

  const segment: TranscriptSegment = {
    segmentId: ref.segmentId,
    timestamp: ref.timestamp,
    userId: ref.userId,
    username: ref.username,
    text,
    noSpeechProb,
    whisper: result,
  };

  return segment;
}

// ── Post-session pipeline ─────────────────────────────────────────────────────

async function inferenceComplete(prompt: string, system: string): Promise<string> {
  try {
    const data = await completeSummarization(prompt, system);
    console.log(
      `[inference] ${data.provider}/${data.model}: ${data.inputTokens ?? "?"} input tokens, ${data.outputTokens ?? "?"} output tokens`,
    );
    if (data.finishReason === "length") {
      throw new UnrecoverableTaskError(
        "Inference output reached the provider or model output limit and was truncated",
      );
    }
    const content = stripCodeFence(data.content.trim());
    if (!content) throw new Error("Summarization provider returned an empty response");
    return content;
  } catch (error) {
    if (APICallError.isInstance(error) && !error.isRetryable) {
      throw new UnrecoverableTaskError(
        `Summarization provider rejected the request${error.statusCode ? ` (${error.statusCode})` : ""}: ${error.message}`,
      );
    }
    throw error;
  }
}

export async function summarize(transcript: Transcript, campaignId: string): Promise<string> {
  const cast = await getCampaignCast(campaignId);
  const formatted = formatTranscriptForInference(transcript, cast);
  return createDetailedRecord(formatted, inferenceComplete);
}

export async function generateTitle(recapText: string): Promise<string> {
  return normalizeTitle(await inferenceComplete(recapText, TITLE_SYSTEM));
}

export async function recap(summary: string): Promise<string> {
  return createRecap(summary, inferenceComplete);
}
