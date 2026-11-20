import { config } from "../config.js";

/**
 * Safaricom Daraja: Lipa Na M-PESA Online (STK Push).
 *
 * Flow: we ask Daraja to push a PIN prompt to the parent's phone → Daraja
 * answers at once with a CheckoutRequestID → the parent enters their PIN →
 * Daraja POSTs the result to our callback URL. If the callback never arrives
 * (it happens), the app asks Daraja for the status (STK Query) instead.
 *
 * MPESA_MODE=mock makes no calls: the "payment" completes by itself after a
 * few seconds (numbers ending in 000 are "cancelled"), for demos and tests.
 */

const BASE = { sandbox: "https://sandbox.safaricom.co.ke", production: "https://api.safaricom.co.ke" } as const;

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
}

export interface StkCallback {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: { Item: { Name: string; Value?: string | number }[] };
}

let cachedToken: { token: string; expires: number } | null = null;

function baseUrl(): string {
  if (config.mpesa.mode === "mock") throw new Error("mock mode makes no Daraja calls");
  return BASE[config.mpesa.mode];
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const { consumerKey, consumerSecret } = config.mpesa;
  if (!consumerKey || !consumerSecret) throw new Error("MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET must be set");
  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: string };
  cachedToken = { token: body.access_token, expires: Date.now() + Number(body.expires_in) * 1000 };
  return cachedToken.token;
}

/** YYYYMMDDHHmmss in Nairobi time, as Daraja expects. */
export function darajaTimestamp(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function password(timestamp: string): string {
  return Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp}`).toString("base64");
}

export function callbackUrl(): string {
  return `${config.publicUrl}/api/mpesa/callback/${config.mpesa.callbackSecret}`;
}

/** Hook for mock mode: how a simulated callback is delivered (set by the payments module). */
let mockDeliver: (cb: StkCallback) => Promise<void> = async () => {};
export function onMockCallback(fn: (cb: StkCallback) => Promise<void>): void {
  mockDeliver = fn;
}

export async function stkPush(input: { phone: string; amount: number; accountReference: string; description: string }): Promise<StkPushResult> {
  if (config.mpesa.mode === "mock") {
    const id = `ws_CO_MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const merchant = `MOCK-${Math.random().toString(36).slice(2, 10)}`;
    const cancelled = input.phone.endsWith("000");
    setTimeout(() => {
      void mockDeliver({
        MerchantRequestID: merchant,
        CheckoutRequestID: id,
        ResultCode: cancelled ? 1032 : 0,
        ResultDesc: cancelled ? "Request cancelled by user" : "The service request is processed successfully.",
        CallbackMetadata: cancelled
          ? undefined
          : {
              Item: [
                { Name: "Amount", Value: input.amount },
                { Name: "MpesaReceiptNumber", Value: `MCK${Math.random().toString(36).slice(2, 9).toUpperCase()}` },
                { Name: "TransactionDate", Value: Number(darajaTimestamp()) },
                { Name: "PhoneNumber", Value: Number(input.phone) },
              ],
            },
      }).catch((err) => console.error("[mpesa mock]", err));
    }, config.mpesa.mockDelayMs);
    return { merchantRequestId: merchant, checkoutRequestId: id, customerMessage: "Success. Request accepted for processing" };
  }

  const timestamp = darajaTimestamp();
  const res = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: config.mpesa.shortcode,
      Password: password(timestamp),
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(input.amount),
      PartyA: input.phone,
      PartyB: config.mpesa.shortcode,
      PhoneNumber: input.phone,
      CallBackURL: callbackUrl(),
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || body.ResponseCode !== "0") {
    throw new Error(body.errorMessage ?? body.ResponseDescription ?? `M-PESA request failed (${res.status})`);
  }
  return { merchantRequestId: body.MerchantRequestID, checkoutRequestId: body.CheckoutRequestID, customerMessage: body.CustomerMessage };
}

/** Ask Daraja for the result of a push whose callback has not arrived. */
export async function stkQuery(checkoutRequestId: string): Promise<{ resultCode: number | null; resultDesc: string }> {
  if (config.mpesa.mode === "mock") return { resultCode: null, resultDesc: "pending" };
  const timestamp = darajaTimestamp();
  const res = await fetch(`${baseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: config.mpesa.shortcode, Password: password(timestamp), Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  // While the parent is still entering their PIN, Daraja answers with an error code (500.001.1001).
  if (body.ResultCode === undefined) return { resultCode: null, resultDesc: body.errorMessage ?? "pending" };
  return { resultCode: Number(body.ResultCode), resultDesc: body.ResultDesc ?? "" };
}

export function metadataValue(cb: StkCallback, name: string): string | number | undefined {
  return cb.CallbackMetadata?.Item.find((i) => i.Name === name)?.Value;
}
