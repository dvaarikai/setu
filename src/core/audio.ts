/**
 * Audio conversion for telephony.
 *
 * Phone networks carry 8 kHz companded audio: μ-law in North America and on
 * most CPaaS defaults, A-law across Europe and much of Asia. Voice engines
 * want linear PCM16. Everything in Setu is normalised to **PCM16
 * little-endian mono** the moment it arrives, and converted back only at the
 * edge, so a provider adapter never has to think about codecs.
 *
 * The companding tables are computed once at load rather than looked up in a
 * literal, because a 256-entry hand-typed table is a place for a silent typo
 * to live and this one is small enough to derive honestly.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** μ-law byte -> PCM16 sample (ITU-T G.711). */
const MULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  t -= BIAS;
  MULAW_TO_PCM[i] = u & 0x80 ? -t : t;
}

/** A-law byte -> PCM16 sample (ITU-T G.711). */
const ALAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const a = i ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else {
    t += 0x108;
    t <<= seg - 1;
  }
  ALAW_TO_PCM[i] = a & 0x80 ? t : -t;
}

export function mulawToPcm(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(MULAW_TO_PCM[buf[i]], i * 2);
  return out;
}

export function alawToPcm(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(ALAW_TO_PCM[buf[i]], i * 2);
  return out;
}

export function pcmToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    let s = pcm.readInt16LE(i * 2);
    const sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
    const mant = (s >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | mant) & 0xff;
  }
  return out;
}

export function pcmToAlaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    let s = pcm.readInt16LE(i * 2);
    const sign = s < 0 ? 0x00 : 0x80;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    let byte: number;
    if (s >= 256) {
      let exp = 7;
      for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
      const mant = (s >> (exp === 0 ? 4 : exp + 3)) & 0x0f;
      byte = (exp << 4) | mant;
    } else {
      byte = s >> 4;
    }
    out[i] = (byte ^ sign ^ 0x55) & 0xff;
  }
  return out;
}

/**
 * Linear resampling between the handful of rates telephony actually uses
 * (8k / 16k / 24k). Linear is the right call here: the ratios are small
 * integers, the band of interest is narrow, and a polyphase filter would add
 * a dependency and latency for a difference nobody hears on a phone line.
 */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const inCount = pcm.length / 2;
  const outCount = Math.floor((inCount * to) / from);
  const out = Buffer.allocUnsafe(outCount * 2);
  const step = inCount / outCount;
  for (let i = 0; i < outCount; i++) {
    const pos = i * step;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, inCount - 1);
    const frac = pos - a;
    const s = pcm.readInt16LE(a * 2) * (1 - frac) + pcm.readInt16LE(b * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

export type Codec = "pcm16" | "mulaw" | "alaw";

/** Provider frame -> canonical PCM16 at `targetRate`. */
export function toPcm16(
  data: Buffer,
  codec: Codec,
  sourceRate: number,
  targetRate: number,
): Buffer {
  const pcm =
    codec === "mulaw" ? mulawToPcm(data) : codec === "alaw" ? alawToPcm(data) : data;
  return resample(pcm, sourceRate, targetRate);
}

/** Canonical PCM16 -> provider frame. */
export function fromPcm16(
  pcm: Buffer,
  codec: Codec,
  sourceRate: number,
  targetRate: number,
): Buffer {
  const r = resample(pcm, sourceRate, targetRate);
  return codec === "mulaw" ? pcmToMulaw(r) : codec === "alaw" ? pcmToAlaw(r) : r;
}
