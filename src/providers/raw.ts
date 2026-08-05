import { resample } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Raw PCM16 over a websocket — the escape hatch.
 *
 * For anything Setu has no adapter for: a home-grown media gateway, an
 * Asterisk AudioSocket shim, a mobile app, a browser, a test harness. Send
 * binary PCM16 mono frames, receive the same back, and send the text frame
 * {"type":"clear"} when you want playback dropped.
 *
 *   wss://your-host/raw?rate=16000
 */
export function rawAdapter(init: AdapterInit): ProviderAdapter {
  const { ws } = init;
  const sampleRate = Number(init.query.get("rate") ?? 16000);

  let resolveReady: (ctx: CallContext) => void;
  const readyPromise = new Promise<CallContext>((r) => (resolveReady = r));
  let audioHandler: ((pcm: Buffer) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;

  queueMicrotask(() =>
    resolveReady({
      callId: init.query.get("callId") ?? `raw-${Date.now()}`,
      from: init.query.get("from") ?? undefined,
      to: init.query.get("to") ?? undefined,
      params: Object.fromEntries(init.query),
    }),
  );

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      audioHandler?.(data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString()) as { type?: string };
      if (msg.type === "stop") closeHandler?.("client_stop");
    } catch {
      /* ignore */
    }
  });

  ws.on("close", () => closeHandler?.("socket_closed"));

  return {
    name: "raw",
    codec: "pcm16",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      if (ws.readyState === 1) ws.send(resample(pcm16, sampleRate, sampleRate));
    },
    clear() {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "interrupted" }));
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
