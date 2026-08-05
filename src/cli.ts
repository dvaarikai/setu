#!/usr/bin/env node
import { startSetu } from "./server.js";

/**
 * `npx @dvaarik/setu` — a working phone agent without writing any code.
 *
 * Set DVAARIK_API_KEY and AGENT_PROMPT, point your provider at the socket,
 * and call the number. Everything is env-configurable so this is also a
 * sane container entrypoint.
 */
const apiKey = process.env.DVAARIK_API_KEY;
if (!apiKey) {
  console.error(
    "DVAARIK_API_KEY is not set.\n" +
      "Get a key at https://developers.dvaarik.com, then:\n\n" +
      "  export DVAARIK_API_KEY=dvk_live_...\n" +
      '  export AGENT_PROMPT="You are Riya, the receptionist at Sunrise Dental."\n' +
      "  npx @dvaarik/setu\n",
  );
  process.exit(1);
}

const prompt =
  process.env.AGENT_PROMPT ??
  "You are a friendly receptionist. Answer in one short sentence.";

const setu = startSetu({
  apiKey,
  port: Number(process.env.PORT ?? 8080),
  baseUrl: process.env.DVAARIK_BASE_URL,
  agent: (ctx) => ({
    prompt,
    language: process.env.AGENT_LANGUAGE ?? "en-IN",
    grade: process.env.AGENT_GRADE ?? "standard",
    voice: process.env.AGENT_VOICE ?? "tara",
    greeting: process.env.AGENT_GREETING,
    metadata: { from: ctx.from, to: ctx.to },
  }),
  onCallEnd: (s) => {
    console.log(
      `[setu] ${s.provider} call ${s.providerCallId} ended after ${s.seconds}s (${s.reason})`,
    );
  },
});

const shutdown = () => {
  console.log("\n[setu] shutting down");
  void setu.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
