import WebSocket from "ws";
import type { EngineStart, VoiceEngine } from "./types.js";

/**
 * The Dvaarik voice engine.
 *
 * Two steps, and that is the whole API: POST /v1/calls to get a single-use
 * socket URL, then stream PCM16 over it. Everything else on this class is
 * bookkeeping so the bridge above can stay dumb.
 */
export interface DvaarikOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface CreateCallResponse {
  call_id: string;
  ws_url: string;
  grade: string;
  rate_paise_per_min: number;
  max_duration_seconds: number;
}

export class DvaarikEngine implements VoiceEngine {
  private ws: WebSocket | null = null;
  private audioHandler: ((pcm: Buffer) => void) | null = null;
  private interruptHandler: (() => void) | null = null;
  private transcriptHandler:
    | ((role: "user" | "assistant", text: string) => void)
    | null = null;
  private endHandler: ((reason: string) => void) | null = null;

  callId: string | null = null;
  ratePaisePerMin: number | null = null;

  constructor(private readonly opts: DvaarikOptions) {}

  private get base(): string {
    return (this.opts.baseUrl ?? "https://api.developers.dvaarik.com").replace(/\/$/, "");
  }

  async start(s: EngineStart): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.base}/v1/calls`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: s.prompt,
        language: s.language ?? "en-IN",
        grade: s.grade ?? "standard",
        voice: s.voice,
        greeting: s.greeting,
        // The bridge normalises everything to one rate and asks for the same
        // rate back, so no resampling happens between here and the carrier.
        sample_rate_in: s.sampleRate,
        sample_rate_out: s.sampleRate,
        metadata: s.metadata,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 402 is the one a caller will actually hit in production, so name it.
      if (res.status === 402) {
        throw new Error(
          `Dvaarik refused the call: balance too low to cover a full-length call. ${body}`,
        );
      }
      throw new Error(`Dvaarik /v1/calls failed (${res.status}): ${body}`);
    }

    const call = (await res.json()) as CreateCallResponse;
    this.callId = call.call_id;
    this.ratePaisePerMin = call.rate_paise_per_min;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(call.ws_url);
      this.ws = ws;
      ws.binaryType = "nodebuffer";

      const onOpenFail = (err: Error) => reject(err);
      ws.once("error", onOpenFail);

      ws.on("open", () => {
        ws.off("error", onOpenFail);
        ws.on("error", () => {
          /* surfaced through close */
        });
        resolve();
      });

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.audioHandler?.(data);
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        switch (msg.type) {
          case "interrupted":
            this.interruptHandler?.();
            break;
          case "transcript":
            this.transcriptHandler?.(
              msg.role as "user" | "assistant",
              String(msg.text ?? ""),
            );
            break;
          case "session_ended":
            this.endHandler?.(String(msg.reason ?? "ended"));
            break;
          case "error":
            this.endHandler?.(String(msg.message ?? "engine error"));
            break;
        }
      });

      ws.on("close", () => this.endHandler?.("socket_closed"));
    });
  }

  sendAudio(pcm16: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm16);
  }

  onAudio(h: (pcm: Buffer) => void): void {
    this.audioHandler = h;
  }
  onInterrupt(h: () => void): void {
    this.interruptHandler = h;
  }
  onTranscript(h: (role: "user" | "assistant", text: string) => void): void {
    this.transcriptHandler = h;
  }
  onEnd(h: (reason: string) => void): void {
    this.endHandler = h;
  }

  stop(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* already gone */
      }
      this.ws.close();
    }
    this.ws = null;
  }
}
