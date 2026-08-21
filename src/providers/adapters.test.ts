import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { AdapterInit, ProviderAdapter } from "../core/types.js";
import { exotelAdapter } from "./exotel.js";
import { frejunAdapter } from "./frejun.js";
import { jambonzAdapter } from "./jambonz.js";
import { plivoAdapter } from "./plivo.js";
import { rawAdapter } from "./raw.js";
import { telnyxAdapter } from "./telnyx.js";
import { twilioAdapter } from "./twilio.js";
import { vobizAdapter } from "./vobiz.js";
import { vonageAdapter } from "./vonage.js";

/**
 * The per-carrier WIRE CONTRACT, pinned.
 *
 * Every adapter here has a "documented trap" — the one frame a developer
 * copying a Twilio example gets wrong, which fails not at connect time but at
 * answer time: the call rings, the caller speaks, and nothing plays back or
 * nothing flushes on a barge-in. The audio core has tests; the framing did
 * not, and the framing is where those silent failures live. These assert the
 * two frames that matter — the one that carries the agent's voice, and the one
 * that stops it when the caller interrupts — against each vendor's own docs.
 */

/** Enough of `ws` to drive an adapter: capture what it sends, feed it frames. */
class FakeWs {
  readyState = 1; // OPEN
  sent: Array<string | Buffer> = [];
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  once(event: string, cb: (...a: unknown[]) => void): this {
    return this.on(event, cb);
  }
  off(): this {
    return this;
  }
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  /** Deliver a JSON text frame, the way `ws` hands adapters a Buffer. */
  recvJson(obj: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
  /** Deliver a binary frame. */
  recvBinary(buf: Buffer): void {
    this.emit("message", buf, true);
  }
  /** The JSON control frames it has sent, parsed. */
  jsonSent(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s));
  }
  binarySent(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}

function makeInit(ws: FakeWs, query = ""): AdapterInit {
  return {
    ws: ws as unknown as WebSocket,
    query: new URLSearchParams(query),
    log: () => {},
  };
}

/** PCM16: 20 ms of silence at 8 kHz is enough to encode. */
const PCM16 = Buffer.alloc(320);
/** A base64 media payload for the JSON carriers (content is irrelevant here). */
const B64 = Buffer.alloc(320).toString("base64");

// ── Twilio ──────────────────────────────────────────────────────────────────
test("twilio: media/streamSid out, clear/streamSid to flush", async () => {
  const ws = new FakeWs();
  const a: ProviderAdapter = twilioAdapter(makeInit(ws));
  ws.recvJson({ event: "start", streamSid: "MZ123", start: { callSid: "CA9" } });
  const ctx = await a.ready();
  assert.equal(ctx.callId, "CA9");

  let heard = 0;
  a.onAudio((pcm) => (heard += pcm.length));
  ws.recvJson({ event: "media", media: { payload: B64 } });
  assert.ok(heard > 0, "inbound μ-law was not decoded to PCM16");

  a.sendAudio(PCM16);
  const media = ws.jsonSent().find((m) => m.event === "media")!;
  assert.equal(media.streamSid, "MZ123");
  assert.ok((media.media as Record<string, unknown>).payload, "no base64 payload");

  a.clear();
  const flush = ws.jsonSent().find((m) => m.event === "clear")!;
  assert.equal(flush.streamSid, "MZ123", "Twilio flush must be clear+streamSid");
});

// ── Exotel — snake_case, the trap ─────────────────────────────────────────────
test("exotel: stream_sid (snake_case) and clear, not Twilio's camelCase", async () => {
  const ws = new FakeWs();
  const a = exotelAdapter(makeInit(ws));
  ws.recvJson({ event: "start", stream_sid: "ex-1", start: { call_sid: "c-1" } });
  const ctx = await a.ready();
  assert.equal(ctx.callId, "c-1");

  // Exotel buffers to a 100 ms floor (3,200 B) and discards anything under it,
  // so a single 20 ms frame would (correctly) not send yet.
  a.sendAudio(Buffer.alloc(3200));
  const media = ws.jsonSent().find((m) => m.event === "media")!;
  assert.equal(media.stream_sid, "ex-1", "Exotel uses stream_sid, not streamSid");
  assert.equal(media.streamSid, undefined);

  a.clear();
  assert.equal(ws.jsonSent().find((m) => m.event === "clear")?.stream_sid, "ex-1");
});

// ── Plivo — playAudio, STRING sampleRate, clearAudio+streamId ─────────────────
test("plivo: playAudio with a STRING sampleRate; clearAudio+streamId", async () => {
  const ws = new FakeWs();
  const a = plivoAdapter(makeInit(ws));
  ws.recvJson({ event: "start", start: { streamId: "pl-1", callId: "pc-1" } });
  await a.ready();

  a.sendAudio(PCM16);
  const play = ws.jsonSent().find((m) => m.event === "playAudio")!;
  assert.ok(play, "Plivo playback is playAudio, not media");
  const media = play.media as Record<string, unknown>;
  assert.equal(typeof media.sampleRate, "string",
    "Plivo's own example shows sampleRate as a STRING — a number is silently rejected");

  a.clear();
  const flush = ws.jsonSent().find((m) => m.event === "clearAudio")!;
  assert.ok(flush, "Plivo flush is clearAudio, not clear");
  assert.equal(flush.streamId, "pl-1");
});

// ── Vobiz — Plivo-adjacent but streamId TOP-LEVEL and NUMERIC sampleRate ───────
test("vobiz: playAudio with top-level streamId and a NUMERIC sampleRate", async () => {
  const ws = new FakeWs();
  const a = vobizAdapter(makeInit(ws));
  ws.recvJson({ event: "start", start: { streamId: "vb-1", callId: "vc-1" } });
  await a.ready();

  a.sendAudio(PCM16);
  const play = ws.jsonSent().find((m) => m.event === "playAudio")!;
  assert.equal(play.streamId, "vb-1", "Vobiz carries streamId at TOP level, unlike Plivo");
  assert.equal(typeof (play.media as Record<string, unknown>).sampleRate, "number",
    "Vobiz's sampleRate is a NUMBER, unlike Plivo's string");

  a.clear();
  assert.equal(ws.jsonSent().find((m) => m.event === "clearAudio")?.streamId, "vb-1");
});

// ── Vonage — binary audio, flush keyed on `action` not `event` ────────────────
test("vonage: binary audio out; flush is {action:clear}, not {event:clear}", async () => {
  const ws = new FakeWs();
  const a = vonageAdapter(makeInit(ws));
  await a.ready(); // no handshake — resolves immediately

  a.sendAudio(PCM16);
  assert.equal(ws.binarySent().length, 1, "Vonage audio is a raw binary frame");

  a.clear();
  const flush = ws.jsonSent().find((m) => m.action === "clear")!;
  assert.ok(flush, "Vonage flush uses the key `action`, not `event`");
  assert.equal(flush.event, undefined);
});

// ── Telnyx — media with NO stream id; clear ───────────────────────────────────
test("telnyx: media out without a stream id; {event:clear} to flush", async () => {
  const ws = new FakeWs();
  const a = telnyxAdapter(makeInit(ws));
  ws.recvJson({ event: "start", start: { call_control_id: "tx-1", media_format: { encoding: "PCMU", sample_rate: 8000 } } });
  const ctx = await a.ready();
  assert.equal(ctx.callId, "tx-1");

  a.sendAudio(PCM16);
  const media = ws.jsonSent().find((m) => m.event === "media")!;
  assert.ok(media, "Telnyx playback is a media event");
  assert.equal(media.stream_id, undefined, "Telnyx needs no stream id on playback");

  a.clear();
  assert.ok(ws.jsonSent().some((m) => m.event === "clear"));
});

// ── jambonz — binary audio; flush is {type:killAudio} ─────────────────────────
test("jambonz: binary audio out; {type:killAudio} to flush", async () => {
  const ws = new FakeWs();
  const a = jambonzAdapter(makeInit(ws, "sampleRate=16000"));
  // The first TEXT frame is metadata, not an event.
  ws.recvJson({ callSid: "jb-1", sampleRate: 16000 });
  await a.ready();

  a.sendAudio(PCM16);
  assert.equal(ws.binarySent().length, 1, "jambonz audio is a raw binary frame");

  a.clear();
  assert.ok(ws.jsonSent().some((m) => m.type === "killAudio"),
    "jambonz flush is killAudio, not clear");
});

// ── FreJun / Teler — {type:clear} to flush ────────────────────────────────────
test("frejun: {type:clear} flushes, and start resolves the call", async () => {
  const ws = new FakeWs();
  const a = frejunAdapter(makeInit(ws));
  ws.recvJson({ type: "start", stream_id: "fj-1", call_id: "fc-1" });
  const ctx = await a.ready();
  assert.ok(ctx.callId, "start must resolve the call");

  a.clear();
  assert.ok(ws.jsonSent().some((m) => m.type === "clear"),
    "FreJun/Teler flush is {type:clear}");
});

// ── raw — binary audio; {type:interrupted} to flush ───────────────────────────
test("raw: binary audio out; {type:interrupted} to flush", async () => {
  const ws = new FakeWs();
  const a = rawAdapter(makeInit(ws));
  await a.ready();

  a.sendAudio(PCM16);
  assert.equal(ws.binarySent().length, 1);

  a.clear();
  assert.ok(ws.jsonSent().some((m) => m.type === "interrupted"));
});

// ── A socket that dies before `start` must not hang the bridge ────────────────
test("an early close settles ready() instead of hanging forever", async () => {
  const ws = new FakeWs();
  const a = twilioAdapter(makeInit(ws));
  ws.close(); // before any start
  const ctx = await a.ready();
  assert.equal(ctx.callId, "unknown", "a pre-start close must resolve, not hang");
});
