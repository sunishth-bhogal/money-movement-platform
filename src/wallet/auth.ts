import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Demo sign-in for the wallet. There are no passwords: you pick a user and
 * get a signed token that names their account. It is a stand-in for real
 * authentication (and all money here is fictional), but authorisation is
 * real: every /me route acts on the account in the token and nothing else,
 * so a user cannot read or move another user's money by changing a request.
 *
 * Token: base64url(account_id) "." expiry (unix seconds) "." HMAC-SHA256 of both.
 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSessionToken(secret: string, accountId: string, now = Date.now()): { token: string; expires_at: string } {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `${Buffer.from(accountId).toString("base64url")}.${exp}`;
  return { token: `${payload}.${sign(secret, payload)}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** The account id in a valid, unexpired token, or null. */
export function verifySessionToken(secret: string, token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id64, expRaw, mac] = parts;
  const expected = Buffer.from(sign(secret, `${id64}.${expRaw}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return null;
  return Buffer.from(id64, "base64url").toString("utf8");
}
