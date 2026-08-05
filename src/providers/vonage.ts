import { resample } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Vonage Voice API websocket.
 *
 * The odd one out, and pleasantly so: audio is RAW BINARY PCM16 in both
 * directions — no base64, no JSON envelope, no stream id to track. Control
 * messages arrive as separate text frames.
 *
 *   in   binary frames, 16-bit signed little-endian PCM, ~20 ms each
 *   out  binary frames, same format
 *   stop TEXT {"action":"clear"} — note the key is `action`, not `event`,
 *        which is unique to Vonage among the providers here
 *
 * NCCO to route a call here:
 *
 *   [{ "action": "connect", "endpoint": [{
 *        "type": "websocket",
 *        "uri": "wss://your-host/vonage",
 *        "content-type": "audio/l16;rate=16000"
 *   }]}]
 */
export function vonageAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;

  // Must match the NCCO content-type. 16 kHz is Vonage's common choice and
  // gives the speech engine better audio than a phone-grade 8 kHz feed.
  const sampleRate = Number(init.query.get("rate") ?? 16000);

  let resolveReady: (ctx: CallContext) => void;
  const readyPromise = new Promise<CallContext>((r) => (resolveReady = r));
  let audioHandler: ((pcm: Buffer) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;
  let settled = false;

  const settle = (ctx: CallContext) => {
    if (settled) return;
    settled = true;
    resolveReady(ctx);
  };

  // Vonage may start sending audio before any control frame, so do not wait
  // on a handshake that might never come — treat the open socket as the call.
  queueMicrotask(() =>
    settle({
      callId: init.query.get("uuid") ?? "vonage-call",
      from: init.query.get("from") ?? undefined,
      to: init.query.get("to") ?? undefined,
      params: Object.fromEntries(init.query),
    }),
  );

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      audioHandler?.(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.event === "websocket:dtmf") log("vonage dtmf", { digit: msg.digit });
      if (msg.event === "websocket:connected") {
        log("vonage connected", { contentType: msg["content-type"] });
      }
    } catch {
      /* not JSON — ignore */
    }
  });

  ws.on("close", () => {
    settle({ callId: "unknown", params: {} });
    closeHandler?.("socket_closed");
  });

  return {
    name: "vonage",
    codec: "pcm16",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      if (ws.readyState === 1) ws.send(resample(pcm16, sampleRate, sampleRate));
    },
    clear() {
      if (ws.readyState === 1) ws.send(JSON.stringify({ action: "clear" }));
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
