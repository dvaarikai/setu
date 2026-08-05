import { fromPcm16, toPcm16, type Codec } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Plivo Audio Streams (bidirectional).
 *
 * Wire format, from Plivo's audio-streams docs:
 *   in   JSON text; base64 audio in media.payload; codec + rate come from
 *        the <Stream contentType> you set in the XML
 *   out  {"event":"playAudio","media":{contentType,sampleRate,payload}}
 *   stop {"event":"clearAudio","streamId":…}
 *
 * XML to route a call here:
 *
 *   <Response>
 *     <Stream bidirectional="true" keepCallAlive="true"
 *             contentType="audio/x-l16;rate=8000">
 *       wss://your-host/plivo
 *     </Stream>
 *   </Response>
 *
 * L16 is worth preferring over μ-law where the account allows it: it skips a
 * companding round-trip on every frame in both directions.
 */
export function plivoAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;

  // Must match the XML's contentType. Overridable per call via the socket
  // query string so one server can host several Plivo apps.
  const wanted = init.query.get("contentType") ?? "audio/x-l16;rate=8000";
  const codec: Codec = wanted.includes("x-l16")
    ? "pcm16"
    : wanted.includes("x-alaw")
      ? "alaw"
      : "mulaw";
  const rateMatch = /rate=(\d+)/.exec(wanted);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 8000;
  const contentType = wanted.split(";")[0];

  let streamId = "";
  let resolveReady: (ctx: CallContext) => void;
  const readyPromise = new Promise<CallContext>((r) => (resolveReady = r));
  let audioHandler: ((pcm: Buffer) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;
  let settled = false;

  ws.on("message", (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      const start = (msg.start ?? {}) as Record<string, unknown>;
      // On `start` the id is nested; on every other event it is top level.
      streamId = String(start.streamId ?? msg.streamId ?? "");
      settled = true;
      resolveReady({
        callId: String(start.callId ?? streamId),
        params: Object.fromEntries(init.query),
      });
      log("plivo stream started", { streamId, callId: start.callId });
      return;
    }

    if (msg.event === "media" && audioHandler) {
      const media = (msg.media ?? {}) as Record<string, unknown>;
      const payload = String(media.payload ?? "");
      if (!payload) return;
      audioHandler(toPcm16(Buffer.from(payload, "base64"), codec, sampleRate, sampleRate));
    }
  });

  ws.on("close", () => {
    if (!settled) {
      settled = true;
      resolveReady({ callId: "unknown", params: {} });
    }
    closeHandler?.("socket_closed");
  });

  const send = (obj: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  return {
    name: "plivo",
    codec,
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      const out = fromPcm16(pcm16, codec, sampleRate, sampleRate);
      send({
        event: "playAudio",
        media: {
          contentType,
          sampleRate,
          payload: out.toString("base64"),
        },
      });
    },
    clear() {
      // streamId is required — Plivo's own SDK refuses the call without it.
      if (streamId) send({ event: "clearAudio", streamId });
    },
    hangup() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
