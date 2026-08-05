import type { AdapterFactory } from "../core/types.js";
import { exotelAdapter } from "./exotel.js";
import { jambonzAdapter } from "./jambonz.js";
import { plivoAdapter } from "./plivo.js";
import { rawAdapter } from "./raw.js";
import { telnyxAdapter } from "./telnyx.js";
import { twilioAdapter } from "./twilio.js";
import { vonageAdapter } from "./vonage.js";

export { exotelAdapter, jambonzAdapter, plivoAdapter, rawAdapter, telnyxAdapter, twilioAdapter, vonageAdapter };

/** Everything Setu can bridge, keyed by the path segment it listens on. */
export const PROVIDERS: Record<string, AdapterFactory> = {
  twilio: twilioAdapter,
  plivo: plivoAdapter,
  exotel: exotelAdapter,
  vonage: vonageAdapter,
  telnyx: telnyxAdapter,
  // SignalWire implements Twilio's Media Streams protocol, so the Twilio
  // adapter drives it unchanged.
  signalwire: twilioAdapter,
  jambonz: jambonzAdapter,
  raw: rawAdapter,
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
