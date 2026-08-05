# Setu

**Bridge any telephony provider to an AI voice agent.**

*सेतु — bridge.*

Your carrier speaks its own dialect of "streaming audio": Twilio sends
base64 μ-law inside JSON, Vonage sends raw binary PCM, Exotel uses snake_case
and enforces a 100 ms minimum frame, Plivo wants `playAudio` and Vonage wants
`{"action":"clear"}`. Setu speaks all of them, hands your voice engine plain
PCM16, and — the part everyone gets wrong — flushes the carrier's playback
buffer the instant the caller interrupts.

```bash
git clone https://github.com/dvaarikai/setu && cd setu
npm install && npm run build

export DVAARIK_API_KEY=dvk_live_...
export AGENT_PROMPT="You are Riya, the receptionist at Sunrise Dental."
npm start
```

Point your provider's stream at `wss://your-host/twilio` and call the number.
That is the whole integration.

*(An `npx @dvaarik/setu` release is coming; until then, clone.)*

---

## Why this exists

Voice agents are four hard problems — hearing, thinking, speaking, and
knowing when to stop talking — plus a fifth nobody warns you about: **the
carrier plumbing**. The fifth one has nothing to do with your product, takes
about a week, and is where most voice projects quietly stall.

Setu is that week, already done, MIT licensed.

## Supported providers

| Provider | Path | Wire format | Status |
| --- | --- | --- | --- |
| **Twilio** | `/twilio` | JSON, base64 μ-law 8 kHz | Documented protocol |
| **SignalWire** | `/signalwire` | Twilio-compatible | Documented protocol |
| **Plivo** | `/plivo` | JSON, base64, L16 or μ-law | Documented protocol |
| **Exotel** 🇮🇳 | `/exotel` | JSON snake_case, base64 L16 8 kHz | **Production-tested** |
| **FreJun / Teler** 🇮🇳 | `/frejun` | JSON, base64 PCM16 8 kHz | **Production-tested** |
| **Vonage** | `/vonage` | Raw binary PCM16 | Documented protocol |
| **Telnyx** | `/telnyx` | JSON, base64 RTP | Documented protocol |
| **jambonz** | `/jambonz` | Binary PCM16 | Documented protocol |
| **Anything else** | `/raw` | Binary PCM16 | — |

"Production-tested" means we run it ourselves, on live calls, every day.
"Documented protocol" means the adapter is written from the vendor's own
published reference and reviewed, but we have not personally run a paid call
through it. If you do, please open an issue either way — that table should
tell the truth.

### Have a SIP trunk rather than a CPaaS account?

Use [jambonz](https://jambonz.org). It is open source, self-hosted, takes a
SIP trunk on one side and gives you a websocket on the other, and Setu speaks
that websocket. You do not need to run a SIP stack yourself, and you keep
your carrier.

## Install

Node 20 or newer. Until the npm release lands, clone the repo and import
from `dist/`, or copy the adapter you need — each one is a single file with
no dependencies beyond `ws`.

## Use it as a library

The CLI is a thin wrapper. In your own service:

```ts
import { startSetu } from "@dvaarik/setu";

startSetu({
  apiKey: process.env.DVAARIK_API_KEY!,
  port: 8080,

  // Called once per incoming call. Because it is a function, one bridge can
  // serve every client you have — look up the tenant by the number dialled.
  agent: async (ctx) => {
    const client = await db.findByPhone(ctx.to);
    return {
      prompt: client.prompt,
      language: client.language,     // en-IN, hi-IN, te-IN, …
      grade: "standard",             // essential | standard | studio_hd | premium
      voice: "tara",                 // tara · nila · vikram · kiran
      greeting: `Greet the caller as ${client.name}.`,
    };
  },

  onCallEnd: (s) => {
    console.log(`${s.provider} ${s.providerCallId}: ${s.seconds}s`);
    console.log(s.transcript);       // yours to keep; we do not store it
  },
});
```

### Wiring each provider

**Twilio** — return this TwiML from your voice webhook. Note that `url` does
not accept a query string; use the path, or `<Parameter>`:

```xml
<Response>
  <Connect>
    <Stream url="wss://your-host/twilio">
      <Parameter name="tenant" value="sunrise-dental" />
    </Stream>
  </Connect>
</Response>
```

**Plivo** — L16 is worth choosing over μ-law where your account allows it; it
skips a companding round trip on every frame:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true"
          contentType="audio/x-l16;rate=8000">
    wss://your-host/plivo?contentType=audio/x-l16;rate=8000
  </Stream>
</Response>
```

**Exotel** — add a Voicebot applet to your flow and point it at
`wss://your-host/exotel`.

**FreJun / Teler** — point your Teler app's stream URL at
`wss://your-host/frejun` (`/teler` works too). This adapter carries three
behaviours we learned the expensive way on live calls:

- it sends **8 kHz** — Teler's play-out is fixed there, and 16 kHz comes out
  as a half-speed ghost;
- it **paces to realtime** with a small lead, because a voice engine emits
  faster than realtime and overflowing Teler's buffer produces a periodic
  burst artifact that is audible on the live leg but **absent from the
  recording**, so you cannot hear it back;
- it **grows its frames** (800 ms, doubling to 2.4 s) because Teler inserts
  roughly a 20 ms pause at each chunk boundary, so fewer boundaries means
  smoother speech — while a small first frame keeps the first word fast.

All three are tunable per call: `?frameMs=800&steadyMs=2400&leadS=1.2`.

**Vonage** — in your NCCO:

```json
[{ "action": "connect", "endpoint": [{
  "type": "websocket",
  "uri": "wss://your-host/vonage?rate=16000",
  "content-type": "audio/l16;rate=16000"
}]}]
```

**Telnyx** — start media streaming with
`stream_bidirectional_mode: "rtp"`. The default is `mp3`, and in that mode
Telnyx expects base64 MP3 back; send it raw audio and you get silence with no
error anywhere.

**jambonz** — in your application:

```json
{
  "verb": "listen",
  "url": "wss://your-host/jambonz?sampleRate=16000",
  "sampleRate": 16000,
  "bidirectionalAudio": { "enabled": true, "streaming": true }
}
```

## Bring your own engine

Setu ships with Dvaarik because that is what we make, but the engine is an
interface. Implement four methods and Setu will bridge any provider to it:

```ts
import { startSetu, type VoiceEngine } from "@dvaarik/setu";

class MyEngine implements VoiceEngine {
  async start(opts) { /* open your session at opts.sampleRate */ }
  sendAudio(pcm16) { /* caller audio in */ }
  onAudio(h) { /* agent audio out */ }
  onInterrupt(h) { /* caller barged in — Setu will flush the carrier */ }
  onTranscript(h) {}
  onEnd(h) {}
  stop() {}
}

startSetu({ apiKey: "", agent, engineFactory: () => new MyEngine() });
```

## Add a provider

An adapter is one file and one interface. Convert the vendor's frames to
PCM16 on the way in, back on the way out, and implement `clear()`:

```ts
import type { AdapterInit, ProviderAdapter } from "@dvaarik/setu";

export function myCarrierAdapter(init: AdapterInit): ProviderAdapter {
  return {
    name: "mycarrier",
    codec: "mulaw",
    sampleRate: 8000,
    ready: () => /* resolve once the call is up */,
    onAudio: (h) => /* call h(pcm16) per frame */,
    onClose: (h) => /* call h(reason) on hangup */,
    sendAudio: (pcm16) => /* encode and send */,
    clear: () => /* flush the carrier's playback buffer */,
    hangup: () => /* close */,
  };
}
```

PRs welcome. `src/providers/twilio.ts` is the clearest one to copy.

## The one thing to get right

**Barge-in.** Carriers queue audio ahead of the caller's ear — often
seconds of it. When the caller interrupts, the engine stops generating, but
the carrier keeps playing what it already has. Without an explicit flush the
caller talks over a sentence the agent abandoned two seconds ago, and the
call feels broken no matter how good the speech is.

Every adapter here implements `clear()`, and the shapes are all different:
Twilio `{"event":"clear"}`, Plivo `{"event":"clearAudio"}`, Exotel
`{"event":"clear"}` (and drop your own buffer too), Vonage
`{"action":"clear"}` — `action`, not `event` — jambonz
`{"type":"killAudio"}`.

That difference is most of why this library exists.

## Audio

Everything is normalised to **PCM16 little-endian mono** at the provider's
native rate the moment it arrives, so adapters never leak codecs upward.
G.711 μ-law and A-law conversion and linear resampling are included, with
tests:

```bash
npm run build && npm test
```

## Using it with Dvaarik

Setu's default engine is the [Dvaarik Voice API](https://developers.dvaarik.com):
speech-to-speech in up to 23 Indian languages, four voices, prepaid from
₹1.50 a minute, no seats and no subscription. Turn latency is about two
seconds — we publish the number we measure, not a best case.

Get a key at **[developers.dvaarik.com](https://developers.dvaarik.com)**.
There is a browser playground there that shows the latency live, so you can
hear it before you write anything.

You do not need Dvaarik to use Setu. The engine interface is public and the
licence is MIT.

## Licence

MIT © [Dvaarik AI](https://www.dvaarik.com)
