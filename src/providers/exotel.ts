import { toPcm16 } from "../core/audio.js";
import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/** Exotel's framing rules for what we send back. These are hard limits: a
 *  frame outside them is dropped silently, which sounds like a dead agent. */
const CHUNK_BYTES = 320; // 20 ms of PCM16 @ 8 kHz — every send must be a multiple
const MIN_SEND = 3200; // 100 ms floor
const MAX_SEND = 100_000; // 100 KB ceiling

/**
 * Exotel Voicebot streaming (India).
 *
 * Wire format — snake_case throughout, unlike Twilio's camelCase, and the
 * audio is already linear PCM16 at 8 kHz so no companding is needed:
 *   in   {"event":"media","stream_sid":…,"media":{"payload":"<base64 L16>"}}
 *   out  {"event":"media","stream_sid":…,"media":{"payload":…}}
 *   stop {"event":"clear","stream_sid":…}
 *
 * The 100 ms minimum is the trap. A voice engine emits audio in small
 * sentence-shaped pieces; forwarding them raw means most frames fall under
 * the floor and Exotel discards them, so the caller hears fragments or
 * nothing. We buffer to a legal size before sending.
 *
 * Route a call here with a Voicebot applet in your Exotel flow pointing at
 * this socket.
 */
export function exotelAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;
  const sampleRate = 8000;

  let streamSid = "";
  let resolveReady: (ctx: CallContext) => void;
  const readyPromise = new Promise<CallContext>((r) => (resolveReady = r));
  let audioHandler: ((pcm: Buffer) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;
  let settled = false;

  // Explicitly typed: Buffer.concat widens to Buffer<ArrayBufferLike> under
  // NodeNext, which will not assign back to an inferred Buffer<ArrayBuffer>.
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

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
        streamSid = String(msg.stream_sid ?? start.stream_sid ?? "");
        settled = true;
        resolveReady({
          callId: String(start.call_sid ?? streamSid),
          from: start.from ? String(start.from) : undefined,
          to: start.to ? String(start.to) : undefined,
          params: {
            ...((start.custom_parameters ?? {}) as Record<string, string>),
            ...Object.fromEntries(init.query),
          },
        });
        log("exotel stream started", { streamSid, callSid: start.call_sid });
        break;
      }

      case "media": {
        const media = (msg.media ?? {}) as Record<string, unknown>;
        const payload = String(media.payload ?? "");
        if (!payload || !audioHandler) return;
        // Already L16 @ 8 kHz — nothing to convert.
        audioHandler(toPcm16(Buffer.from(payload, "base64"), "pcm16", sampleRate, sampleRate));
        break;
      }

      case "dtmf":
        log("exotel dtmf", { digit: (msg.dtmf as Record<string, unknown>)?.digit });
        break;

      case "stop":
        closeHandler?.("stop");
        break;
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

  const flush = (force: boolean) => {
    if (!streamSid) return;
    while (pending.length >= MIN_SEND || (force && pending.length > 0)) {
      let take = Math.min(pending.length, MAX_SEND);
      // Always a whole number of 20 ms frames.
      take = Math.floor(take / CHUNK_BYTES) * CHUNK_BYTES;
      if (take === 0) {
        if (!force) return;
        // Forced tail shorter than one frame: pad it rather than drop it.
        const padded = Buffer.concat([pending, Buffer.alloc(CHUNK_BYTES - pending.length)]);
        send({ event: "media", stream_sid: streamSid, media: { payload: padded.toString("base64") } });
        pending = Buffer.alloc(0);
        return;
      }
      const chunk = pending.subarray(0, take);
      pending = pending.subarray(take);
      send({ event: "media", stream_sid: streamSid, media: { payload: chunk.toString("base64") } });
      if (!force && pending.length < MIN_SEND) return;
    }
  };

  return {
    name: "exotel",
    codec: "pcm16",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),
    sendAudio(pcm16) {
      pending = pending.length ? Buffer.concat([pending, pcm16]) : pcm16;
      flush(false);
    },
    clear() {
      // Drop OUR buffer as well as Exotel's, or the abandoned tail is
      // prepended to the next turn and the agent talks over itself.
      pending = Buffer.alloc(0);
      if (streamSid) send({ event: "clear", stream_sid: streamSid });
    },
    hangup() {
      flush(true);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
