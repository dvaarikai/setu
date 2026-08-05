import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * jambonz `listen` verb — and, in practice, the answer to "I have a SIP
 * trunk, not a CPaaS account".
 *
 * jambonz is open source and self-hosted: point your SIP trunk at it and it
 * hands you the call audio over a websocket, which is exactly what this
 * bridge wants. No SIP stack of your own, no carrier lock-in.
 *
 *   in   BINARY frames, linear PCM16 at the verb's `sampleRate`; the FIRST
 *        frame is TEXT and carries the call metadata
 *   out  BINARY PCM16 (requires `bidirectionalAudio.streaming: true`)
 *   stop TEXT {"type":"killAudio"}
 *
 * Verb:
 *
 *   {
 *     "verb": "listen",
 *     "url": "wss://your-host/jambonz",
 *     "sampleRate": 16000,
 *     "mixType": "mono",
 *     "bidirectionalAudio": { "enabled": true, "streaming": true }
 *   }
 */
export function jambonzAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;
  const sampleRate = Number(init.query.get("sampleRate") ?? 16000);

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

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      audioHandler?.(raw);
      return;
    }
    // The first text frame is the call metadata; later ones are events.
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.event === "dtmf") {
        log("jambonz dtmf", { digit: msg.dtmf });
        return;
      }
      settle({
        callId: String(msg.call_sid ?? msg.callSid ?? "jambonz-call"),
        from: msg.from ? String(msg.from) : undefined,
        to: msg.to ? String(msg.to) : undefined,
        params: Object.fromEntries(init.query),
      });
      log("jambonz call metadata received", { callId: msg.call_sid ?? msg.callSid });
    } catch {
      /* not JSON — ignore */
    }
  });

  // If jambonz sends audio before any metadata frame, do not stall the call.
  const guard = setTimeout(
    () => settle({ callId: "jambonz-call", params: Object.fromEntries(init.query) }),
    2000,
  );

  ws.on("close", () => {
    clearTimeout(guard);
    settle({ callId: "unknown", params: {} });
    closeHandler?.("socket_closed");
  });

  return {
    name: "jambonz",
    codec: "pcm16",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      if (ws.readyState === 1) ws.send(pcm16);
    },
    clear() {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "killAudio" }));
    },
    hangup() {
      clearTimeout(guard);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
