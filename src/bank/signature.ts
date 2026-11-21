import { createHmac, timingSafeEqual } from "node:crypto";

// Webhook signatures, in the same shape as Stripe's:
//   Bank-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// The timestamp is signed too, so a captured request cannot be replayed later.

export const BANK_SIGNATURE_HEADER = "bank-signature";

function hmac(secret: string, timestamp: number, body: string | Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

export function signBankWebhook(secret: string, body: string | Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/** Throws unless the header is a valid signature of exactly these bytes, made within the tolerance. */
export function verifyBankWebhook(
  rawBody: Buffer,
  header: string,
  secret: string,
  { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {},
): void {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || typeof parts.v1 !== "string") throw new Error("malformed signature header");
  if (Math.abs(nowSec - timestamp) > toleranceSec) throw new Error("signature timestamp outside tolerance");
  const expected = Buffer.from(hmac(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("signature mismatch");
}
