import { fromPcm16, toPcm16, type Codec } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Telnyx Media Streaming.
 *
 *   in   JSON text; base64 RTP payload (headers already stripped) in
 *        media.payload; codec from start.media_format.encoding (PCMU default)
 *   out  {"event":"media","media":{"payload":…}} — no stream id required
 *   stop {"event":"clear"}
 *
 * ⚠ Set `stream_bidirectional_mode` to `rtp` when you start the stream. The
 * default is `mp3`, and in that mode Telnyx expects a base64 MP3 back — send
 * it raw audio and you get silence with no error anywhere.
 */
export function telnyxAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;

  let codec: Codec = "mulaw"; // PCMU default; corrected from `start`
  let sampleRate = 8000;

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
      const fmt = (start.media_format ?? {}) as Record<string, unknown>;
      const enc = String(fmt.encoding ?? "PCMU").toUpperCase();
      codec = enc === "PCMA" ? "alaw" : enc === "L16" ? "pcm16" : "mulaw";
      sampleRate = Number(fmt.sample_rate ?? 8000);
      settled = true;
      resolveReady({
        callId: String(start.call_control_id ?? msg.stream_id ?? "telnyx-call"),
        from: start.from ? String(start.from) : undefined,
        to: start.to ? String(start.to) : undefined,
        params: Object.fromEntries(init.query),
      });
      log("telnyx stream started", { encoding: enc, sampleRate });
      return;
    }

    if (msg.event === "media" && audioHandler) {
      const media = (msg.media ?? {}) as Record<string, unknown>;
      const payload = String(media.payload ?? "");
      if (!payload) return;
      audioHandler(toPcm16(Buffer.from(payload, "base64"), codec, sampleRate, sampleRate));
    }

    if (msg.event === "stop") closeHandler?.("stop");
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
    name: "telnyx",
    get codec() {
      return codec;
    },
    get sampleRate() {
      return sampleRate;
    },
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      const out = fromPcm16(pcm16, codec, sampleRate, sampleRate);
      send({ event: "media", media: { payload: out.toString("base64") } });
    },
    clear() {
      send({ event: "clear" });
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
