import { fromPcm16, toPcm16, type Codec } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Vobiz voice streaming (bidirectional).
 *
 * Wire format, from vobiz.ai/docs/concepts/streaming-websockets (read
 * 2026-08-19). The dialect is Plivo-adjacent — same XML element, same
 * playAudio/clearAudio verbs — with two differences that matter:
 *
 *   in    JSON text; base64 audio in media.payload. The START event carries
 *         mediaFormat {encoding, sampleRate}, and that is authoritative: the
 *         adapter re-tunes itself to whatever the platform says the call
 *         actually is, so a mismatch with the query default degrades to a
 *         one-line log instead of half-speed audio.
 *   out   {"event":"playAudio","streamId":…,"media":{contentType,sampleRate,
 *         payload}} — streamId rides at TOP LEVEL on playback here, which
 *         Plivo's dialect does not do. sampleRate is a NUMBER, per their
 *         published example (Plivo's is a string; the two dialects disagree
 *         and each adapter follows its own vendor's page).
 *   stop  {"event":"clearAudio","streamId":…}
 *
 * Vobiz asks for outbound playback in ~20-60 ms chunks; the engine's framing
 * already lands in that window, so no extra buffering is done here.
 *
 * XML to route a call here:
 *
 *   <Response>
 *     <Stream bidirectional="true" keepCallAlive="true"
 *             contentType="audio/x-l16;rate=8000">
 *       wss://your-host/vobiz
 *     </Stream>
 *   </Response>
 *
 * L16 up to 24 kHz is supported; 8 kHz is the safe floor for PSTN legs.
 */
export function vobizAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;

  const wanted = init.query.get("contentType") ?? "audio/x-l16;rate=8000";
  let codec: Codec = wanted.includes("x-l16")
    ? "pcm16"
    : wanted.includes("x-alaw")
      ? "alaw"
      : "mulaw";
  const rateMatch = /rate=(\d+)/.exec(wanted);
  let sampleRate = rateMatch ? Number(rateMatch[1]) : 8000;
  let contentType = wanted.split(";")[0];

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
      streamId = String(start.streamId ?? msg.streamId ?? "");

      // The platform states the call's real format on start. Believe it over
      // the query default — a disagreement between the two is otherwise heard
      // as static or half-speed speech, with nothing anywhere naming why.
      const fmt = (start.mediaFormat ?? {}) as Record<string, unknown>;
      const enc = String(fmt.encoding ?? "");
      if (enc) {
        codec = enc.includes("x-l16") ? "pcm16" : enc.includes("x-alaw") ? "alaw" : "mulaw";
        contentType = enc.split(";")[0];
      }
      const rate = Number(fmt.sampleRate ?? 0);
      if (rate > 0 && rate !== sampleRate) {
        log("vobiz mediaFormat overrides configured rate", {
          configured: sampleRate,
          actual: rate,
        });
        sampleRate = rate;
      }

      settled = true;
      resolveReady({
        callId: String(start.callId ?? streamId),
        params: Object.fromEntries(init.query),
      });
      log("vobiz stream started", { streamId, callId: start.callId, sampleRate });
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
    name: "vobiz",
    codec,
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      const out = fromPcm16(pcm16, codec, sampleRate, sampleRate);
      send({
        event: "playAudio",
        // Top-level, unlike Plivo — Vobiz's own playback example carries it.
        streamId,
        media: {
          contentType,
          sampleRate,
          payload: out.toString("base64"),
        },
      });
    },
    clear() {
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
