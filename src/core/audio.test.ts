import assert from "node:assert/strict";
import test from "node:test";
import { alawToPcm, fromPcm16, mulawToPcm, pcmToAlaw, pcmToMulaw, resample, toPcm16 } from "./audio.js";

/** A 300 Hz sine at 8 kHz — speech-shaped enough to exercise the companding
 *  curve across its range rather than only near zero. */
function tone(samples: number, rate = 8000, hz = 300, amp = 12000): Buffer {
  const b = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  }
  return b;
}

function rmsError(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a.readInt16LE(i * 2) - b.readInt16LE(i * 2);
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

test("mu-law survives a round trip within its quantisation error", () => {
  const pcm = tone(800);
  const back = mulawToPcm(pcmToMulaw(pcm));
  assert.equal(back.length, pcm.length);
  // G.711 is lossy by design; ~1% of full scale is the expected noise floor.
  assert.ok(rmsError(pcm, back) < 330, `mu-law rms error too high: ${rmsError(pcm, back)}`);
});

test("A-law survives a round trip within its quantisation error", () => {
  const pcm = tone(800);
  const back = alawToPcm(pcmToAlaw(pcm));
  assert.equal(back.length, pcm.length);
  assert.ok(rmsError(pcm, back) < 400, `a-law rms error too high: ${rmsError(pcm, back)}`);
});

test("mu-law encodes one byte per sample", () => {
  assert.equal(pcmToMulaw(tone(160)).length, 160);
});

test("silence stays silent through mu-law", () => {
  const silence = Buffer.alloc(320);
  const back = mulawToPcm(pcmToMulaw(silence));
  for (let i = 0; i < back.length / 2; i++) {
    assert.ok(Math.abs(back.readInt16LE(i * 2)) < 12, "silence gained a DC offset");
  }
});

test("resampling changes length by the rate ratio", () => {
  const pcm = tone(800);
  assert.equal(resample(pcm, 8000, 16000).length, pcm.length * 2);
  assert.equal(resample(pcm, 8000, 24000).length, pcm.length * 3);
  assert.equal(resample(resample(pcm, 8000, 16000), 16000, 8000).length, pcm.length);
  // Same rate must be a pass-through, not a copy through the interpolator.
  assert.equal(resample(pcm, 8000, 8000), pcm);
});

test("a resampled round trip still resembles the original", () => {
  const pcm = tone(1600);
  const back = resample(resample(pcm, 8000, 16000), 16000, 8000);
  assert.ok(rmsError(pcm, back) < 900, `resample rms error too high: ${rmsError(pcm, back)}`);
});

test("the provider-facing helpers compose to identity", () => {
  const pcm = tone(800);
  // What a Twilio-shaped adapter does: PCM16 out to the wire, back in again.
  const wire = fromPcm16(pcm, "mulaw", 8000, 8000);
  const back = toPcm16(wire, "mulaw", 8000, 8000);
  assert.equal(back.length, pcm.length);
  assert.ok(rmsError(pcm, back) < 330);
});

test("pcm16 passes through untouched at the same rate", () => {
  const pcm = tone(320);
  assert.deepEqual(toPcm16(pcm, "pcm16", 8000, 8000), pcm);
});
