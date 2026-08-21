# Setu: connect an AI voice agent to an Indian carrier

**Setu is an MIT-licensed TypeScript bridge between a carrier's bidirectional
audio stream and any speech-to-speech voice engine.** It gives Twilio,
SignalWire, Plivo, Exotel, FreJun/Teler, Vonage, Telnyx, and Vobiz one PCM16 interface,
including the carrier-specific command that clears queued speech when a caller
interrupts. A jambonz adapter connects a SIP trunk; a raw PCM adapter covers
custom media gateways.

*Setu (सेतु) means bridge.*

If you already have an Indian phone number or SIP trunk, the shortest route is:

1. run Setu on a public HTTPS/WSS host;
2. point the carrier's bidirectional media stream to Setu's provider path; and
3. connect Setu to Dvaarik or implement the `VoiceEngine` interface for your own
   realtime model.

Setu handles media framing, codecs, sample rates, and playback-buffer clearing.
Your carrier still controls number purchase, KYC, calling permissions, call
routing, and telephony charges.

## Quick start with a Dvaarik voice agent

`@dvaarik/setu` version 0.1.0 is public on npm (verified 15 August 2026) and
requires Node.js 20 or newer.

```bash
export DVAARIK_API_KEY=dvk_live_...
export AGENT_PROMPT="You are the receptionist for Sunrise Dental. Keep answers short."

npx @dvaarik/setu
```

Setu listens on `PORT` (default `8080`). Deploy it behind a TLS endpoint, then
point the carrier at its matching WebSocket path, for example
`wss://voice.example.in/exotel` or `wss://voice.example.in/plivo`.

Confirm the process is reachable before routing a paid call:

```bash
curl https://voice.example.in/health
```

The response lists the adapter paths loaded by the running build. Do not send a
production call until the carrier's WebSocket authentication or source
allow-list is also configured; see [Production security](#production-security).

To run from source:

```bash
git clone https://github.com/dvaarikai/setu.git
cd setu
npm install
npm run build
npm test
npm start
```

## Which Indian carriers and telephony providers does Setu support?

The table describes **the code in Setu 0.1.0**, not every codec or commercial
feature a provider may offer. “Production-tested” means Dvaarik has run live
paid calls through that adapter. “Docs-implemented” means the adapter was built
against the linked provider specification but Dvaarik had not run a paid call
through it as of 15 August 2026.

| Provider | Setu path | Audio Setu implements | Two-way audio | Barge-in / queue clear | Verification status |
|---|---|---|:---:|---|---|
| Twilio Media Streams | `/twilio` | base64 G.711 μ-law, 8 kHz | Yes | `event: clear` | Docs-implemented |
| SignalWire compatibility path | `/signalwire` | Twilio-shaped base64 μ-law, 8 kHz | Yes | `event: clear` | Docs-implemented; confirm the stream protocol on your account |
| Plivo Audio Streams | `/plivo` | base64 L16 at 8 or 16 kHz; μ-law at 8 kHz | Yes | `event: clearAudio` | Docs-implemented |
| Exotel Voicebot | `/exotel` | base64 PCM16 little-endian mono, 8 kHz | Yes | `event: clear`; Setu also drops its local buffer | **Production-tested** |
| FreJun / Teler | `/frejun` or `/teler` | base64 PCM16, 8 kHz, paced by Setu | Yes | `type: clear`; Setu also drops its local buffer | **Production-tested** |
| Vonage Voice API | `/vonage` | raw binary PCM16; example uses 16 kHz | Yes | `action: clear` | Docs-implemented |
| Telnyx media streaming | `/telnyx` | base64 PCMU/PCMA at 8 kHz or L16 at 16 kHz in RTP mode | Yes | `event: clear` | Docs-implemented |
| Vobiz Audio Streams | `/vobiz` | base64 L16 or μ-law; format from the `start` event | Yes | `event: clearAudio` | Docs-implemented |

Carrier-independent routes:

| Gateway | Setu path | Use it when | Audio | Queue clear |
|---|---|---|---|---|
| [jambonz](https://docs.jambonz.org/verbs/verbs/listen) | `/jambonz` | You have a SIP trunk and want an open-source, self-hosted media gateway | raw binary PCM16 | `type: killAudio` |
| Custom/raw WebSocket | `/raw` | You already own the media gateway | raw binary PCM16 | Setu emits `type: interrupted` |

Every adapter normalises caller audio to little-endian mono PCM16 before the
voice engine sees it. G.711 μ-law/A-law conversion and linear resampling are
included. The source of truth for the exact implemented message shapes is
[`src/providers/`](src/providers/).

## Working carrier configurations

Replace `voice.example.in` with the public host running Setu. The carrier must
reach it over `wss://`.

### Exotel

In the Exotel call flow, add a **Voicebot Applet**, select bidirectional
streaming, use an 8 kHz sample rate, and set the endpoint to:

```text
wss://voice.example.in/exotel
```

Setu implements Exotel's snake_case `stream_sid` messages, 8 kHz PCM payloads,
100 ms outbound buffering, and `clear`. Exotel's live Voicebot documentation
also describes Basic Authentication and IP allow-listing for the WSS endpoint;
enable one of them before production.

### FreJun / Teler

Set the Teler application's bidirectional stream URL to either alias:

```text
wss://voice.example.in/frejun
wss://voice.example.in/teler
```

The production-tested adapter sends 8 kHz PCM16, paces generated audio to
realtime, and grows frames from an 800 ms first frame toward a 2.4 s steady
frame. Those are Setu defaults measured on Dvaarik's live calls, not a general
performance promise for every Teler account. Override them per call only after
listening to a real carrier leg:

```text
wss://voice.example.in/teler?frameMs=800&steadyMs=2400&leadS=1.2
```

### Plivo

Return this XML from the Plivo answer URL. The WebSocket query must match the
`contentType` in the `<Stream>` element.

```xml
<Response>
  <Stream bidirectional="true"
          keepCallAlive="true"
          contentType="audio/x-l16;rate=8000">
    wss://voice.example.in/plivo?contentType=audio/x-l16;rate=8000
  </Stream>
</Response>
```

Setu also accepts `audio/x-l16;rate=16000` and
`audio/x-mulaw;rate=8000`. Plivo's current guide requires bidirectional mode
for AI responses and documents `clearAudio` for interruption.

### Twilio

Return this TwiML from the number's voice webhook:

```xml
<Response>
  <Connect>
    <Stream url="wss://voice.example.in/twilio">
      <Parameter name="tenant" value="sunrise-dental" />
      <Parameter name="from" value="+919876543210" />
      <Parameter name="to" value="+914012345678" />
    </Stream>
  </Connect>
</Response>
```

Twilio does not allow a query string in the `<Stream url>`. The example numbers
are placeholders: generate this TwiML in your webhook handler and insert the
validated `From` and `To` values from Twilio's request into `<Parameter>`
elements. Its bidirectional stream accepts
base64 μ-law at 8 kHz and uses `clear` to discard buffered media.

### SignalWire

Use the same compatibility XML shape as Twilio, but route the stream to:

```text
wss://voice.example.in/signalwire
```

This path intentionally reuses Setu's Twilio-shaped adapter. SignalWire's live
documentation describes its REST API and cXML as compatibility interfaces; the
Setu path remains docs-implemented rather than paid-call tested, so validate
start, media, and clear events on a non-production number first.

### Vonage

Connect the call to a WebSocket endpoint in the NCCO:

```json
[
  {
    "action": "connect",
    "endpoint": [
      {
        "type": "websocket",
        "uri": "wss://voice.example.in/vonage?rate=16000",
        "content-type": "audio/l16;rate=16000"
      }
    ]
  }
]
```

The `rate` query value must match the NCCO content type. Vonage sends and
receives raw PCM binary frames and clears queued audio with
`{"action":"clear"}`.

### Telnyx

When starting or answering the call, use RTP bidirectional mode and a codec the
Setu adapter implements:

```json
{
  "stream_url": "wss://voice.example.in/telnyx",
  "stream_track": "inbound_track",
  "stream_bidirectional_mode": "rtp",
  "stream_bidirectional_codec": "PCMU"
}
```

Do not leave `stream_bidirectional_mode` at `mp3`: RTP mode is what lets Setu
send carrier audio frames back. Supported Setu choices are `PCMU`, `PCMA`, and
`L16`; Telnyx offers additional codecs that this release does not decode.

### jambonz with any SIP trunk

Use jambonz when the Indian carrier supplies a SIP trunk rather than a media
streaming API. Point the trunk at jambonz, then use its `listen` verb:

```json
{
  "verb": "listen",
  "url": "wss://voice.example.in/jambonz?sampleRate=16000",
  "actionHook": "https://voice.example.in/listen-ended",
  "sampleRate": 16000,
  "mixType": "mono",
  "bidirectionalAudio": {
    "enabled": true,
    "streaming": true,
    "sampleRate": 16000
  }
}
```

The query value, inbound `sampleRate`, and outbound
`bidirectionalAudio.sampleRate` must agree. Setu sends raw PCM binary frames in
both directions and maps interruption to jambonz `killAudio`.

## Use Setu as a library

Install it in a Node.js service:

```bash
npm install @dvaarik/setu
```

This complete example uses the built-in Dvaarik engine and selects the agent
configuration for every incoming call:

```ts
import { startSetu } from "@dvaarik/setu";

const apiKey = process.env.DVAARIK_API_KEY;
if (!apiKey) throw new Error("DVAARIK_API_KEY is required");

const setu = startSetu({
  apiKey,
  port: Number(process.env.PORT ?? 8080),
  agent: (call) => ({
    prompt: "You are the receptionist for Sunrise Dental. Keep answers short.",
    language: "en-IN",
    grade: "standard",
    voice: "tara",
    greeting: "Welcome to Sunrise Dental. How may I help?",
    metadata: {
      carrierFrom: call.from,
      carrierTo: call.to,
      tenant: call.params.tenant,
    },
  }),
  onCallEnd: (summary) => {
    console.log({
      provider: summary.provider,
      providerCallId: summary.providerCallId,
      seconds: summary.seconds,
      reason: summary.reason,
    });
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void setu.close());
}
```

Setu passes the provider call ID, `from`, `to`, and provider parameters into
the agent callback where the carrier supplies them. Twilio numbers must be
forwarded as custom parameters, as shown above.

## Bring your own voice engine

Setu is not locked to Dvaarik. Implement the `VoiceEngine` methods and supply an
`engineFactory`; Setu will keep the carrier adapter unchanged.

```ts
import { startSetu, type EngineStart, type VoiceEngine } from "@dvaarik/setu";

class MyRealtimeEngine implements VoiceEngine {
  async start(options: EngineStart): Promise<void> {
    // Open one realtime model session at options.sampleRate.
  }
  sendAudio(pcm16: Buffer): void { /* caller audio into the model */ }
  onAudio(handler: (pcm16: Buffer) => void): void { /* model audio out */ }
  onInterrupt(handler: () => void): void { /* invoke on caller barge-in */ }
  onTranscript(handler: (role: "user" | "assistant", text: string) => void): void {}
  onEnd(handler: (reason: string) => void): void {}
  stop(): void {}
}

startSetu({
  apiKey: "", // unused by a custom engine
  agent: () => ({ prompt: "Answer as the business receptionist." }),
  engineFactory: () => new MyRealtimeEngine(),
});
```

The engine must emit PCM16 at the `sampleRate` passed to `start()`. When it
detects an interruption, it must call the registered interrupt handler; Setu
then invokes the active carrier adapter's queue-clear command.

## Why queue clearing matters

Carriers buffer outbound audio. Stopping generation inside the AI engine does
not remove speech already waiting in the carrier's playback queue. Without a
carrier-specific clear command, the caller hears an abandoned sentence after
they interrupt.

Setu keeps that difference inside each adapter:

| Adapter | Clear command sent by Setu |
|---|---|
| Twilio / SignalWire | `{"event":"clear","streamSid":"..."}` |
| Plivo | `{"event":"clearAudio","streamId":"..."}` |
| Exotel | `{"event":"clear","stream_sid":"..."}` |
| FreJun / Teler | `{"type":"clear"}` |
| Vonage | `{"action":"clear"}` |
| Telnyx | `{"event":"clear"}` |
| jambonz | `{"type":"killAudio"}` |

## Production security

Setu 0.1.0 is a media bridge, not an account-provisioning or public-edge
security product. Before routing real calls:

- terminate TLS and expose only `wss://`;
- validate the carrier's signed WebSocket upgrade where the carrier provides a
  signature, or enforce its documented source IP allow-list / Basic Auth;
- place Setu behind connection, payload-size, call-duration, and concurrency
  limits appropriate to your account;
- never put the Dvaarik key or another engine key in carrier XML, query strings,
  browser code, or logs;
- log provider call IDs, not raw audio or transcripts, unless your consent and
  retention policy explicitly requires those records; and
- begin with a carrier-approved test number and a non-production call flow.

Twilio's current Media Streams guide explicitly requires validation of the
`X-Twilio-Signature` header. Exotel's current Voicebot guide documents IP
allow-listing and Basic Authentication. Setu does not yet implement those
provider-specific edge checks for you.

## Add another carrier

An adapter converts the carrier's frames to PCM16 on input, encodes PCM16 on
output, and implements `clear()`:

```ts
import type { AdapterInit, ProviderAdapter } from "@dvaarik/setu";

export function myCarrierAdapter(init: AdapterInit): ProviderAdapter {
  return {
    name: "mycarrier",
    codec: "mulaw",
    sampleRate: 8000,
    ready: async () => ({ callId: "provider-call-id", params: {} }),
    onAudio: (handler) => { /* decode frames, then call handler(pcm16) */ },
    onClose: (handler) => { /* call handler(reason) on hangup */ },
    sendAudio: (pcm16) => { /* encode and send to the carrier */ },
    clear: () => { /* flush carrier and local playback queues */ },
    hangup: () => init.ws.close(),
  };
}
```

Copy [`src/providers/twilio.ts`](src/providers/twilio.ts) for a JSON/base64
provider or [`src/providers/vonage.ts`](src/providers/vonage.ts) for a raw
binary provider. Pull requests should say whether the adapter is tested on a
paid call or implemented from documentation only.

## Dated protocol references

All links below were live-read on **15 August 2026**. A provider may change its
WebSocket schema independently of Setu, so re-check the source before a new
production integration.

| Provider | Primary reference checked | What it confirms |
|---|---|---|
| Twilio | [Media Streams WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages) | bidirectional media, base64 μ-law/8 kHz, `clear` |
| SignalWire | [Compatibility REST API](https://developer.signalwire.com/rest/compatibility-api) and [cXML compatibility](https://developer.signalwire.com/compatibility-api/client-sdks/methods/cxml-applications/) | compatibility API and TwiML-compatible cXML positioning |
| Plivo | [Audio Streams API](https://docs.plivo.com/docs/voice/api/audio-streams) and [AI voice-agent streaming guide](https://docs.plivo.com/docs/voice-agents/audio-streaming/overview) | bidirectional `<Stream>`, audio formats, `playAudio`, `clearAudio` guidance |
| Exotel | [Voicebot Applet](https://docs.exotel.com/exotel-agentstream/voicebot-applet) | bidirectional WSS, PCM16 framing, snake_case events, `clear`, WSS authentication options |
| FreJun / Teler | [FreJun real-time audio streaming](https://frejun.com/teler-blog/how-can-a-voice-api-for-developers-handle-real-time-audio-streaming/) | Teler bidirectional WebSocket architecture; adapter tuning remains Setu's production measurement |
| Vonage | [Voice API WebSocket guide](https://developer.vonage.com/en/voice/voice-api/concepts/websockets) | raw PCM binary audio and `{"action":"clear"}` |
| Telnyx | [Media Streaming over WebSockets](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming) | RTP bidirectional mode, codecs, media and `clear` messages |
| jambonz | [`listen` verb](https://docs.jambonz.org/verbs/verbs/listen) | binary linear PCM, bidirectional streaming, `killAudio` |
| Setu package | [npm package](https://www.npmjs.com/package/@dvaarik/setu) | public version 0.1.0, Node.js requirement, MIT package metadata |

## Scope and verification

- The audio conversion suite covers μ-law, A-law, PCM16 pass-through, and 8/16/24
  kHz resampling: `npm run build && npm test`.
- Exotel and FreJun/Teler are the only adapters marked production-tested as of
  15 August 2026.
- No README claim upgrades a docs-implemented adapter to production-tested.
- Setu does not buy numbers, complete carrier KYC, place calls by itself, or
  make a carrier support a codec that the carrier account has not enabled.
- The Dvaarik engine is optional. Its current public API terms are separate from
  this MIT-licensed bridge; check [developers.dvaarik.com](https://developers.dvaarik.com)
  before use.

## License

MIT © [Dvaarik AI](https://www.dvaarik.com)
