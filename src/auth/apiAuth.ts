import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { ApiError } from "../errors.js";
import { verifySessionToken } from "../wallet/auth.js";

/**
 * Who is calling the account, transfer, deposit and payout API.
 *
 *  - An operator sends `Authorization: Bearer <ADMIN_TOKEN>` and may act on
 *    any user account (the same token as /admin; a stand-in for real service
 *    credentials).
 *  - A user sends the wallet's demo session token (`POST /me/session`) and
 *    may only see and act on their own account. The sign-in is a demo, but the
 *    authorisation is real: the account comes from the signed token, never
 *    from the request body.
 *
 * Anything else is a 401. With neither ADMIN_TOKEN nor WALLET_SESSION_SECRET
 * set, nobody can sign in, so these routes answer 503.
 */
export type Principal = { kind: "operator" } | { kind: "user"; accountId: string };

export interface ApiAuthOptions {
  adminToken?: string;
  sessionSecret?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasCredentials(req: FastifyRequest): boolean {
  return req.headers.authorization !== undefined;
}

export async function authenticate(pool: pg.Pool, req: FastifyRequest, opts: ApiAuthOptions): Promise<Principal> {
  if (!opts.adminToken && !opts.sessionSecret) {
    throw new ApiError(503, "auth_not_configured", "Set ADMIN_TOKEN or WALLET_SESSION_SECRET so callers can sign in.");
  }
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (given) {
    // Compare digests so the comparison takes the same time whatever the length.
    if (opts.adminToken && timingSafeEqual(digest(given), digest(opts.adminToken))) return { kind: "operator" };
    if (opts.sessionSecret) {
      const accountId = verifySessionToken(opts.sessionSecret, given);
      if (accountId && UUID.test(accountId)) {
        const { rows } = await pool.query("SELECT 1 FROM accounts WHERE id = $1 AND kind = 'user'", [accountId]);
        if (rows.length) return { kind: "user", accountId };
      }
    }
  }
  throw new ApiError(401, "unauthorized", "Send Authorization: Bearer <ADMIN_TOKEN>, or a wallet session token from POST /me/session.");
}

/** Operators see everything; a user sees only things that involve their own account. */
export function canSee(who: Principal, ...accountIds: string[]): boolean {
  return who.kind === "operator" || accountIds.includes(who.accountId);
}

export function requireOperator(who: Principal): void {
  if (who.kind !== "operator") throw new ApiError(403, "forbidden", "Only an operator (ADMIN_TOKEN) can do this.");
}

/** A user may only move money out of (or into, for deposits) their own account. */
export function requireOwnAccount(who: Principal, accountId: string): void {
  if (!canSee(who, accountId)) throw new ApiError(403, "forbidden", "You can only act on your own account.");
}

/**
 * Users' Idempotency-Keys are namespaced by account, like the wallet's, so
 * one user cannot replay (or squat) another's request by guessing its key.
 * Operators' keys are used as sent.
 */
export function scopeKey(who: Principal, key: string): string {
  return who.kind === "operator" ? key : `user:${who.accountId}:${key}`;
}
