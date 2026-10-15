import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionData {
  v: 1;
  apiKey: string;
  user: { name?: string; email?: string };
  projectName?: string;
  expiresAt?: string;
  issuedAt: number;
}

export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

const keyFor = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'decision-benchmarks', 'decision-benchmarks-session-v1', 32));

/**
 * A key for one purpose of the service's own, from SESSION_SECRET: HMAC(secret, "decision-benchmarks:" + purpose), as
 * the answer and seed keys are made. A value sealed for one purpose (a game's table, say) never opens for another, nor
 * as a session.
 */
export const purposeKey = (secret: string, purpose: string): Buffer => createHmac('sha256', secret).update(`decision-benchmarks:${purpose}`).digest();

/** Any JSON value, sealed with AES-256-GCM under a 32-byte key, encoded as base64url `iv.ciphertext.tag`. */
export function seal(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

/** A sealed value, or null for anything missing, tampered, malformed or sealed under another key. */
export function unseal(sealed: unknown, key: Buffer): unknown {
  if (typeof sealed !== 'string' || !sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, ct, tag] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv!.length !== 12 || tag!.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv!);
    decipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** AES-256-GCM, encoded as base64url `iv.ciphertext.tag`. */
export function sealSession(data: SessionData, secret: string): string {
  return seal(data, keyFor(secret));
}

/** The session, or null for anything missing, tampered, malformed, sealed with another secret, or expired. */
export function openSession(sealed: string | undefined, secret: string, now = Date.now()): SessionData | null {
  const data = unseal(sealed, keyFor(secret)) as SessionData | null;
  if (data?.v !== 1 || typeof data.apiKey !== 'string' || !data.apiKey || typeof data.issuedAt !== 'number') return null;
  if (now - data.issuedAt > SESSION_MAX_AGE_S * 1000) return null;
  if (data.expiresAt && !(Date.parse(data.expiresAt) > now)) return null;
  return data;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore undecodable values
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict';
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.path) parts.push(`Path=${o.path}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
