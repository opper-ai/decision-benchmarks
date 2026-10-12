import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionData {
  v: 1;
  apiKey: string;
  user: { name?: string; email?: string };
  issuedAt: number;
  expiresAt?: string;
}

export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
const key = (secret: string) => createHash('sha256').update(secret).digest();

/** AES-256-GCM sealed, base64url: iv.tag.ciphertext */
export function seal(data: SessionData, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function open(token: string | undefined, secret: string, now = Date.now()): SessionData | null {
  if (!token || !secret) return null;
  try {
    const [iv, tag, body] = token.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(secret), iv);
    d.setAuthTag(tag);
    const data = JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8')) as SessionData;
    if (data.v !== 1 || typeof data.apiKey !== 'string') return null;
    if (now - data.issuedAt > SESSION_MAX_AGE_S * 1000) return null;
    if (data.expiresAt && !(Date.parse(data.expiresAt) > now)) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const k = part.indexOf('=');
    if (k < 0) continue;
    out[part.slice(0, k).trim()] = decodeURIComponent(part.slice(k + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge: number; path: string; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.floor(opts.maxAge)}; Path=${opts.path}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
