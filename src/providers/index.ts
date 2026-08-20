import type { AdapterFactory } from "../core/types.js";
import { exotelAdapter } from "./exotel.js";
import { frejunAdapter } from "./frejun.js";
import { jambonzAdapter } from "./jambonz.js";
import { plivoAdapter } from "./plivo.js";
import { rawAdapter } from "./raw.js";
import { telnyxAdapter } from "./telnyx.js";
import { twilioAdapter } from "./twilio.js";
import { vobizAdapter } from "./vobiz.js";
import { vonageAdapter } from "./vonage.js";

export { exotelAdapter, frejunAdapter, jambonzAdapter, plivoAdapter, rawAdapter, telnyxAdapter, twilioAdapter, vobizAdapter, vonageAdapter };

/** Everything Setu can bridge, keyed by the path segment it listens on. */
export const PROVIDERS: Record<string, AdapterFactory> = {
  twilio: twilioAdapter,
  plivo: plivoAdapter,
  exotel: exotelAdapter,
  // FreJun ships its voice API as Teler; both names hit the same adapter.
  frejun: frejunAdapter,
  teler: frejunAdapter,
  vonage: vonageAdapter,
  // Vobiz speaks a Plivo-adjacent dialect with its own quirks (top-level
  // streamId on playback, numeric sampleRate) — a separate adapter, not an
  // alias, so neither vendor's changes can break the other.
  vobiz: vobizAdapter,
  telnyx: telnyxAdapter,
  // SignalWire implements Twilio's Media Streams protocol, so the Twilio
  // adapter drives it unchanged.
  signalwire: twilioAdapter,
  jambonz: jambonzAdapter,
  raw: rawAdapter,
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
