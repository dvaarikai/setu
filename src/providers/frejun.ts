import type { AdapterInit, CallContext, ProviderAdapter } from "../core/types.js";

/**
 * FreJun / Teler bidirectional media streaming (India).
 *
 *   in    {"type":"audio","data":{"audio_b64":"<base64 PCM16 8 kHz>"}}
 *   out   {"type":"audio","audio_b64":"…","chunk_id":<n>}
 *   stop  {"type":"clear"}  (or {"type":"interrupt","chunk_id":n} for one chunk)
 *
 * Teler closes the socket when the call ends — there is no `stop` event.
 *
 * ── The three rules that make this sound right ──────────────────────────
 * We run this provider in production every day, and each of these cost us
 * real debugging. They are the reason this adapter is longer than the others.
 *
 * 1. SEND 8 kHz. Teler's play-out is fixed at 8 kHz; hand it 16 kHz and the
 *    caller hears a half-speed ghost.
 *
 * 2. PACE TO REALTIME. A voice engine emits speech faster than realtime —
 *    six seconds of audio can arrive in one. Dumping that straight down the
 *    socket overflows Teler's play-out buffer, and the overflow is audible
 *    as a periodic burst, like radio interference riding on clean speech.
 *    Worse, it is ABSENT from the recording, because the recording is
 *    stitched from the bytes we sent — so it only exists on the live leg and
 *    you cannot hear it back. The pacer keeps a small lead (default 1.2 s)
 *    so the buffer never overflows and never starves.
 *
 * 3. USE FEWER, BIGGER FRAMES. Teler's player inserts roughly a 20 ms pause
 *    at the start of every chunk_id, whatever the buffer depth. Uniform
 *    small frames therefore stutter. The ladder sends a small first frame
 *    for fast first-word latency, then doubles each frame up to a ceiling:
 *    few boundaries once speech is flowing, no latency cost at the start.
 *
 * Defaults here are the values the owner confirmed clean on a live call.
 * Every one is overridable per call via the socket query string.
 */
export function frejunAdapter(init: AdapterInit): ProviderAdapter {
  const { ws, log } = init;

  const sampleRate = 8000; // rule 1 — not negotiable
  const num = (k: string, d: number) => Number(init.query.get(k) ?? d);

  const firstFrameMs = num("frameMs", 800);
  const steadyFrameMs = num("steadyMs", 2400); // 0 disables the ladder
  const leadSeconds = num("leadS", 1.2);
  const tailFlushMs = num("tailMs", 700);

  const bytesFor = (ms: number) => Math.floor(sampleRate * (ms / 1000) * 2);
  const firstFrameBytes = bytesFor(firstFrameMs);
  const steadyBytes = steadyFrameMs > 0 ? bytesFor(steadyFrameMs) : firstFrameBytes;

  let resolveReady: (ctx: CallContext) => void;
  const readyPromise = new Promise<CallContext>((r) => (resolveReady = r));
  let audioHandler: ((pcm: Buffer) => void) | null = null;
  let closeHandler: ((reason: string) => void) | null = null;
  let settled = false;

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let chunkId = 0;
  let nextFrameBytes = firstFrameBytes;
  /** Playout position we have already funded, in ms since the pacer started. */
  let playoutAheadMs = 0;
  let pacerAt = 0;
  let lastAudioAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const settle = (ctx: CallContext) => {
    if (settled) return;
    settled = true;
    resolveReady(ctx);
  };

  const send = (obj: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const emit = (frame: Buffer) => {
    chunkId += 1;
    send({ type: "audio", audio_b64: frame.toString("base64"), chunk_id: chunkId });
    playoutAheadMs += (frame.length / 2 / sampleRate) * 1000;
    // The ladder: bigger every frame, up to the ceiling.
    nextFrameBytes = Math.min(nextFrameBytes * 2, steadyBytes);
  };

  /** Drain whatever is due, then sleep until the next frame is due. */
  const pump = () => {
    timer = null;
    const now = Date.now();
    if (pacerAt === 0) pacerAt = now;

    // How far the caller's ear has advanced since we started pacing.
    const elapsedMs = now - pacerAt;
    const leadMs = leadSeconds * 1000;

    while (pending.length >= nextFrameBytes && playoutAheadMs - elapsedMs < leadMs) {
      const frame = pending.subarray(0, nextFrameBytes);
      pending = pending.subarray(nextFrameBytes);
      emit(frame);
    }

    // A sub-frame tail is only real once the engine has gone quiet — flushing
    // on any gap pads silence into the middle of a sentence.
    if (pending.length > 0 && now - lastAudioAt > tailFlushMs) {
      emit(pending);
      pending = Buffer.alloc(0);
    }

    if (pending.length > 0 || playoutAheadMs > elapsedMs) {
      timer = setTimeout(pump, 100);
    } else {
      // Idle: the queue drained and playout caught up. Reset so the next turn
      // starts small again and its first word is fast.
      pacerAt = 0;
      playoutAheadMs = 0;
      nextFrameBytes = firstFrameBytes;
    }
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(pump, 0);
  };

  ws.on("message", (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "start") {
      const d = (msg.data ?? msg) as Record<string, unknown>;
      settle({
        callId: String(d.call_id ?? d.stream_id ?? "frejun-call"),
        from: d.from ? String(d.from) : undefined,
        to: d.to ? String(d.to) : undefined,
        params: Object.fromEntries(init.query),
      });
      log("frejun stream started", { callId: d.call_id });
      return;
    }

    if (msg.type === "audio" && audioHandler) {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      const b64 = String(data.audio_b64 ?? msg.audio_b64 ?? "");
      if (!b64) return;
      // Already PCM16 @ 8 kHz.
      audioHandler(Buffer.from(b64, "base64"));
    }
  });

  ws.on("close", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Teler sends no `stop` — the socket closing IS the hangup.
    settle({ callId: "unknown", params: {} });
    closeHandler?.("socket_closed");
  });

  return {
    name: "frejun",
    codec: "pcm16",
    sampleRate,
    ready: () => readyPromise,
    onAudio: (h) => (audioHandler = h),
    onClose: (h) => (closeHandler = h),

    sendAudio(pcm16) {
      // Enqueue only — never block here, or the engine's barge-in timing
      // starts measuring our socket instead of the conversation.
      pending = pending.length ? Buffer.concat([pending, pcm16]) : pcm16;
      lastAudioAt = Date.now();
      schedule();
    },

    clear() {
      // Drop OUR backlog as well as Teler's queue. Keeping it would replay an
      // abandoned sentence after the barge-in, which is worse than not
      // supporting barge-in at all.
      pending = Buffer.alloc(0);
      playoutAheadMs = 0;
      pacerAt = 0;
      nextFrameBytes = firstFrameBytes;
      send({ type: "clear" });
    },

    hangup() {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
