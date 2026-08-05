import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { bridge, type BridgeSummary } from "./core/bridge.js";
import { DvaarikEngine } from "./core/dvaarik.js";
import type { CallContext, EngineStart, VoiceEngine } from "./core/types.js";
import { PROVIDERS, PROVIDER_NAMES } from "./providers/index.js";

export interface SetuOptions {
  /** Dvaarik API key. Get one at https://developers.dvaarik.com */
  apiKey: string;
  port?: number;
  baseUrl?: string;

  /**
   * The agent for an incoming call. A function, not a constant, so the
   * prompt can depend on who is calling and which number they rang — which
   * is how one bridge serves every client you have.
   */
  agent: (ctx: CallContext) => Omit<EngineStart, "sampleRate"> | Promise<Omit<EngineStart, "sampleRate">>;

  onCallEnd?: (summary: BridgeSummary) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;

  /** Swap in your own engine. Defaults to Dvaarik. */
  engineFactory?: () => VoiceEngine;
}

export interface SetuServer {
  server: Server;
  close(): Promise<void>;
}

/**
 * One websocket server, one path per provider:
 *
 *   wss://your-host/twilio      wss://your-host/plivo
 *   wss://your-host/exotel      wss://your-host/vonage
 *   wss://your-host/telnyx      wss://your-host/jambonz
 *   wss://your-host/raw
 *
 * Point your provider's stream at the matching path and Setu does the rest.
 */
export function startSetu(opts: SetuOptions): SetuServer {
  const log = opts.log ?? ((m, e) => console.log(`[setu] ${m}`, e ?? ""));
  const port = opts.port ?? Number(process.env.PORT ?? 8080);

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", providers: PROVIDER_NAMES }));
      return;
    }
    res.writeHead(404).end("Setu: connect a websocket to /<provider>");
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const provider = url.pathname.split("/").filter(Boolean)[0] ?? "";
    const factory = PROVIDERS[provider];

    if (!factory) {
      log("rejected upgrade: unknown provider", { path: url.pathname });
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const adapter = factory({ ws, query: url.searchParams, log });
      const engine = opts.engineFactory?.() ?? new DvaarikEngine({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      });

      void (async () => {
        try {
          const ctx = await adapter.ready();
          const call = await opts.agent(ctx);
          await bridge({ adapter, engine, call, log, onEnd: opts.onCallEnd });
        } catch (err) {
          // A failed call must hang up the carrier leg. Leaving it open bills
          // the customer for a line with nobody on it.
          log("call failed", { error: err instanceof Error ? err.message : String(err) });
          try {
            adapter.hangup();
          } catch {
            /* already gone */
          }
        }
      })();
    });
  });

  server.listen(port, () => {
    log(`listening on :${port}`, { providers: PROVIDER_NAMES.join(", ") });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}
