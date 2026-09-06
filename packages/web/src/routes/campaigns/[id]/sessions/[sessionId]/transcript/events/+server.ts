import { error } from "@sveltejs/kit";
import {
  getCampaignAccess,
  getCampaignCast,
  getSessionDetail,
  getSessionStatus,
  listLiveTranscriptSegments,
} from "@rainbot/db";
import type { RequestHandler } from "./$types";

const encoder = new TextEncoder();
const TERMINAL_STATUSES = new Set(["done", "failed"]);

function event(name: string, data: unknown, id?: string): Uint8Array {
  const idLine = id ? `id: ${id}\n` : "";
  return encoder.encode(`${idLine}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const GET: RequestHandler = async ({ params, locals, request }) => {
  if (!locals.user) throw error(401, "Please log in to view this transcript.");

  const session = await getSessionDetail(params.sessionId);
  if (!session || session.campaignId !== params.id) throw error(404, "Session not found.");
  const access = await getCampaignAccess(session.campaignId, locals.user.id);
  if (!access.canAccess) throw error(403, "You cannot view this campaign.");

  const cast = await getCampaignCast(session.campaignId);
  const characterByUserId = new Map(cast.map((member) => [member.userId, member.characterName]));

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sent = new Set<string>();
      let cursor: Date | undefined;
      let lastStatus: string | null = null;

      void (async () => {
        try {
          while (true) {
            if (cancelled || request.signal.aborted) return;
            const [segments, status] = await Promise.all([
              listLiveTranscriptSegments(session.id, cursor),
              getSessionStatus(session.id),
            ]);

            if (cancelled || request.signal.aborted) return;
            for (const segment of segments) {
              const id = `${segment.runId}:${segment.segmentId}`;
              if (sent.has(id)) continue;
              sent.add(id);
              controller.enqueue(
                event(
                  "snippet",
                  {
                    id,
                    timestamp: segment.timestamp,
                    userId: segment.userId,
                    speaker: segment.username ?? segment.userId,
                    characterName: characterByUserId.get(segment.userId) ?? null,
                    text: segment.text,
                  },
                  id,
                ),
              );
            }
            const latest = segments.at(-1)?.transcribedAt;
            if (latest && (!cursor || latest > cursor)) cursor = latest;

            if (status !== lastStatus) {
              lastStatus = status;
              controller.enqueue(event("status", { status }));
            }
            if (!status || TERMINAL_STATUSES.has(status)) {
              controller.enqueue(event("complete", { status }));
              controller.close();
              return;
            }

            controller.enqueue(encoder.encode(": keepalive\n\n"));
            await wait(1_000, request.signal);
          }
        } catch (streamError) {
          if (!cancelled && !request.signal.aborted) controller.error(streamError);
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
};
