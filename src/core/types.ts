import type { WebSocket } from "ws";
import type { Codec } from "./audio.js";

/**
 * A provider adapter's whole job: turn one telephony vendor's socket into
 * the two things a voice engine needs — a stream of PCM16 in, and a way to
 * push PCM16 out and to stop pushing when the caller interrupts.
 *
 * Everything vendor-specific (base64 or binary, JSON envelope or raw frame,
 * μ-law or PCM, 8 kHz or 16 kHz, streamSid bookkeeping) is confined here.
 * The bridge above never learns which provider it is talking to.
 */
export interface CallContext {
  /** Provider's own id for the call — logged, and echoed in metadata. */
  callId: string;
  /** The number that was dialled, when the provider tells us. */
  to?: string;
  /** The caller's number, when the provider tells us. */
  from?: string;
  /** Anything the provider passed through (Twilio customParameters etc.). */
  params: Record<string, string>;
}

export interface ProviderAdapter {
  readonly name: string;

  /** Sample rate and codec this provider speaks on the wire. */
  readonly codec: Codec;
  readonly sampleRate: number;

  /**
   * Resolves once the provider has told us the call is really up. Adapters
   * that learn the call id from a `start` event resolve then; adapters with
   * no handshake resolve immediately.
   */
  ready(): Promise<CallContext>;

  /** Caller audio, already normalised to PCM16 at `sampleRate`. */
  onAudio(handler: (pcm16: Buffer) => void): void;

  /** The provider hung up, or the socket died. */
  onClose(handler: (reason: string) => void): void;

  /** Send agent audio. Takes PCM16 at `sampleRate`; the adapter encodes. */
  sendAudio(pcm16: Buffer): void;

  /**
   * Barge-in. Drop whatever the carrier has buffered for playback.
   *
   * This is the single most important method in the file. Providers queue
   * audio ahead of the caller's ear, so without an explicit flush the caller
   * keeps hearing a sentence the agent abandoned a second ago, and the call
   * feels broken however good the speech is.
   */
  clear(): void;

  /** End the call from our side. */
  hangup(): void;
}

export interface AdapterInit {
  ws: WebSocket;
  /** Query string of the websocket upgrade — many providers pass ids here. */
  query: URLSearchParams;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export type AdapterFactory = (init: AdapterInit) => ProviderAdapter;

/** What the agent side must implement. Dvaarik is the built-in one. */
export interface VoiceEngine {
  /** Open a session; returns once the engine is ready for audio. */
  start(opts: EngineStart): Promise<void>;
  /** Caller audio in, PCM16 at the rate given in EngineStart. */
  sendAudio(pcm16: Buffer): void;
  /** Agent audio out. */
  onAudio(handler: (pcm16: Buffer) => void): void;
  /** The caller interrupted — stop playing and drop the queue. */
  onInterrupt(handler: () => void): void;
  onTranscript(handler: (role: "user" | "assistant", text: string) => void): void;
  onEnd(handler: (reason: string) => void): void;
  stop(): void;
}

export interface EngineStart {
  prompt: string;
  language?: string;
  grade?: string;
  voice?: string;
  greeting?: string;
  /** The rate the bridge will send and expects back. */
  sampleRate: number;
  metadata?: Record<string, unknown>;
}
