import type { WebSocket } from "ws";
import { fromPcm16, toPcm16 } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * Twilio Media Streams (bidirectional, via `<Connect><Stream>`).
 *
 * Wire format, from Twilio's websocket-messages reference:
 *   in   JSON text frames; audio is base64 μ-law, 8 kHz mono, ~20 ms/frame
 *   out  {"event":"media","streamSid":…,"media":{"payload":…}}
 *   stop {"event":"clear","streamSid":…} flushes queued playback
 *
 * TwiML to route a call here — note `url` takes NO query string, so per-call
 * data goes in the path or in <Parameter>:
 *
 *   <Response>
 *     <Connect>
 *       <Stream url="wss://your-host/twilio/abc123">
 *         <Parameter name="agent" value="reception" />
 *       </Stream>
 *     </Connect>
 *   </Response>
 */
export function twilioAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;
  const sampleRate = 8000;

  let streamSid = "";
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

    switch (msg.event) {
      case "connected":
        break;

      case "start": {
        const start = (msg.start ?? {}) as Record<string, unknown>;
        streamSid = String(msg.streamSid ?? start.streamSid ?? "");
        const custom = (start.customParameters ?? {}) as Record<string, string>;
        settled = true;
        resolveReady({
          callId: String(start.callSid ?? streamSid),
          // Twilio does not put the numbers on the stream `start` — they are
          // on the voice webhook that returned the TwiML. Pass them through
          // as <Parameter> if you need them here.
          from: custom.from,
          to: custom.to,
          params: { ...custom, ...Object.fromEntries(init.query) },
        });
        log("twilio stream started", { streamSid, callSid: start.callSid });
        break;
      }

      case "media": {
        const media = (msg.media ?? {}) as Record<string, unknown>;
        const payload = String(media.payload ?? "");
        if (!payload || !audioHandler) return;
        const mulaw = Buffer.from(payload, "base64");
        audioHandler(toPcm16(mulaw, "mulaw", sampleRate, sampleRate));
        break;
      }

      case "dtmf":
        log("twilio dtmf", { digit: (msg.dtmf as Record<string, unknown>)?.digit });
        break;

      case "stop":
        closeHandler?.("stop");
        break;
    }
  });

  ws.on("close", () => {
    // A socket that dies before `start` would leave bridge() awaiting for
    // ever; settle it so the caller sees a closed call, not a hang.
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
    name: "twilio",
    codec: "mulaw",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      if (!streamSid) return;
      const mulaw = fromPcm16(pcm16, "mulaw", sampleRate, sampleRate);
      send({
        event: "media",
        streamSid,
        media: { payload: mulaw.toString("base64") },
      });
    },
    clear() {
      if (streamSid) send({ event: "clear", streamSid });
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
