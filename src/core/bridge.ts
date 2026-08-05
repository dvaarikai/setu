import type { ProviderAdapter, VoiceEngine, EngineStart } from "./types.js";

/**
 * The bridge: caller audio in one side, agent audio out the other, and the
 * one rule that makes a phone conversation feel human — when the caller
 * starts talking, stop talking.
 *
 * Deliberately small. Everything vendor-shaped lives in an adapter and
 * everything agent-shaped lives behind VoiceEngine, so this file is the part
 * you can read in a minute and trust.
 */
export interface BridgeOptions {
  adapter: ProviderAdapter;
  engine: VoiceEngine;
  call: Omit<EngineStart, "sampleRate">;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  onEnd?: (summary: BridgeSummary) => void;
}

export interface BridgeSummary {
  provider: string;
  providerCallId: string;
  reason: string;
  seconds: number;
  callerBytes: number;
  agentBytes: number;
  transcript: { role: "user" | "assistant"; text: string }[];
}

export async function bridge(opts: BridgeOptions): Promise<BridgeSummary> {
  const { adapter, engine } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();

  let callerBytes = 0;
  let agentBytes = 0;
  const transcript: BridgeSummary["transcript"] = [];
  let finished = false;

  const ctx = await adapter.ready();
  log("call up", { provider: adapter.name, callId: ctx.callId, from: ctx.from });

  await engine.start({
    ...opts.call,
    // One rate end to end. The adapter has already converted the carrier's
    // codec to PCM16 at its native rate, and we ask the engine for the same
    // rate back, so no resampling happens in the middle of the call.
    sampleRate: adapter.sampleRate,
    metadata: {
      ...opts.call.metadata,
      provider: adapter.name,
      provider_call_id: ctx.callId,
      from: ctx.from,
      to: ctx.to,
    },
  });

  adapter.onAudio((pcm) => {
    callerBytes += pcm.length;
    engine.sendAudio(pcm);
  });

  engine.onAudio((pcm) => {
    agentBytes += pcm.length;
    adapter.sendAudio(pcm);
  });

  // Barge-in. The engine decides the caller interrupted; the carrier is the
  // only one who can drop what it has already buffered toward their ear.
  engine.onInterrupt(() => adapter.clear());

  engine.onTranscript((role, text) => {
    transcript.push({ role, text });
    log(`${role}: ${text}`);
  });

  return await new Promise<BridgeSummary>((resolve) => {
    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      const summary: BridgeSummary = {
        provider: adapter.name,
        providerCallId: ctx.callId,
        reason,
        seconds: Math.round((Date.now() - started) / 1000),
        callerBytes,
        agentBytes,
        transcript,
      };
      try {
        engine.stop();
      } catch {
        /* already stopped */
      }
      try {
        adapter.hangup();
      } catch {
        /* already gone */
      }
      log("call ended", { reason, seconds: summary.seconds });
      opts.onEnd?.(summary);
      resolve(summary);
    };

    // Either end hanging up ends the call. The agent finishing its goodbye
    // must drop the carrier leg too, or the caller sits in silence paying
    // for a line nobody is on.
    adapter.onClose((reason) => finish(`caller:${reason}`));
    engine.onEnd((reason) => finish(`agent:${reason}`));
  });
}
