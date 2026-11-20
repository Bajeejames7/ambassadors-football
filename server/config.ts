import { createHash } from "node:crypto";

export type MpesaMode = "mock" | "sandbox" | "production";

export interface Settings {
  databaseUrl: string;
  /** Whoever holds this email is always a Super Admin; it cannot be removed by editing users. */
  creatorEmail: string;
  tokenSecret: string;
  port: number;
  publicUrl: string;
  /** Default time zone for new countries; each country carries its own. */
  defaultTimeZone: string;
  mpesa: {
    mode: MpesaMode;
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    callbackSecret: string;
    /** How long mock payments take to "complete". */
    mockDelayMs: number;
  };
  airtableApiKey: string;
}

function fromEnv(): Settings {
  const env = process.env;
  const databaseUrl = env.DATABASE_URL ?? "";
  const mode = (env.MPESA_MODE ?? "mock") as MpesaMode;
  return {
    databaseUrl,
    creatorEmail: (env.CREATOR_EMAIL ?? "").trim().toLowerCase(),
    tokenSecret: env.TOKEN_SECRET ?? createHash("sha256").update(`ambassadors:${databaseUrl}`).digest("hex"),
    port: Number(env.PORT ?? 3000),
    publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    defaultTimeZone: "Africa/Nairobi",
    mpesa: {
      mode: ["mock", "sandbox", "production"].includes(mode) ? mode : "mock",
      consumerKey: env.MPESA_CONSUMER_KEY ?? "",
      consumerSecret: env.MPESA_CONSUMER_SECRET ?? "",
      shortcode: env.MPESA_SHORTCODE ?? "174379",
      passkey: env.MPESA_PASSKEY ?? "",
      callbackSecret: env.MPESA_CALLBACK_SECRET ?? createHash("sha256").update(`mpesa:${databaseUrl}`).digest("hex").slice(0, 32),
      mockDelayMs: Number(env.MPESA_MOCK_DELAY_MS ?? 5000),
    },
    airtableApiKey: env.AIRTABLE_API_KEY ?? "",
  };
}

export const config: Settings = fromEnv();
