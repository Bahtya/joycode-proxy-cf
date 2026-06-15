// JWT helpers (port of pkg/auth/jwt.go).
//
// Go uses golang-jwt with HS256, issuer "joycode-proxy", and a Claims struct
// embedding { username } + RegisteredClaims { ExpiresAt, IssuedAt, Issuer }.
// Here we use the `jose` library, which offers the same HS256/JWT semantics.
//
// Signing secret resolution (mirrors Go's auto-gen pattern in handler.go:320-323
// and middleware.go:65): env.JWT_SECRET (a Workers Secret) takes precedence; if
// unset we fall back to the `auth_jwt_secret` setting in D1. The setup/login
// handlers seed that setting when both are absent (see functions/api/auth/*).

import { SignJWT, jwtVerify } from 'jose';
import type { Env } from '../types';
import { getSetting } from '../store/settings';
import { SettingKeys } from '../types';

const ISSUER = 'joycode-proxy';

/** Default JWT lifetime — matches Go defaultJWTExpiry = 24h (handler.go:260). */
export const DEFAULT_JWT_EXPIRY_SECONDS = 24 * 60 * 60;

/** UTF-8 encode a secret into the Uint8Array jose expects for HS256. */
function keyBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Resolve the HS256 signing secret.
 *
 * Order: env.JWT_SECRET (Workers Secret) → D1 `auth_jwt_secret` setting.
 * Returns null when neither is configured.
 */
export async function resolveJwtSecret(env: Env): Promise<string | null> {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const stored = await getSetting(env.DB, SettingKeys.authJwtSecret);
  return stored && stored !== '' ? stored : null;
}

export interface JwtPayload {
  username: string;
}

/**
 * Sign a JWT for the given username. Mirrors auth.GenerateToken.
 *
 * @param username  subject username (Go uses "root" for the dashboard admin).
 * @param secret    HS256 secret string.
 * @param expirySec lifetime in seconds (default 24h, matching Go defaultJWTExpiry).
 */
export async function signJWT(
  username: string,
  secret: string,
  expirySec: number = DEFAULT_JWT_EXPIRY_SECONDS
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setExpirationTime(now + expirySec)
    .sign(keyBytes(secret));
}

/**
 * Verify a JWT and return its payload, or null on any validation failure
 * (bad signature, expired, wrong issuer, malformed). Mirrors auth.ValidateToken
 * which returns (nil, err) — callers treat any error as "invalid or expired".
 */
export async function verifyJWT(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, keyBytes(secret), {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    const username = payload.username;
    if (typeof username !== 'string') return null;
    return { username };
  } catch {
    return null;
  }
}
