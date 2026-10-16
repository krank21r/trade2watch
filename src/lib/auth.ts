/**
 * Trade2watch auth — 3 fixed credentials, signed stateless sessions.
 *
 * Tokens are `base64url(payload).base64url(HMAC-SHA256(payload, secret))` so
 * BOTH the edge middleware and node route handlers can verify them with Web
 * Crypto (no DB round-trip). The session cookie is httpOnly; two readable
 * cookies (t2w_uid / t2w_name) let the client scope personal localStorage
 * state per user — they are convenience labels, NOT credentials.
 *
 * Credentials come from the environment ONLY — the repository is public, so
 * no password or signing key may ever live in code:
 *   T2W_PASS_KRANTHI / T2W_PASS_ANALYST1 / T2W_PASS_ANALYST2
 *   AUTH_SECRET (rotating it instantly invalidates all sessions)
 * A user whose env var is missing simply cannot sign in until it is set.
 */

export interface AuthUser {
  id: string
  name: string
  role: 'owner' | 'analyst'
}

export const SESSION_COOKIE = 't2w_session'
export const UID_COOKIE = 't2w_uid'
export const NAME_COOKIE = 't2w_name'
export const SESSION_DAYS = 30

const USERS: Array<AuthUser & { username: string; password: string }> = [
  { id: 'kranthi', username: 'kranthi', name: 'Kranthi', role: 'owner', password: process.env.T2W_PASS_KRANTHI?.trim() ?? '' },
  { id: 'analyst1', username: 'analyst1', name: 'Analyst One', role: 'analyst', password: process.env.T2W_PASS_ANALYST1?.trim() ?? '' },
  { id: 'analyst2', username: 'analyst2', name: 'Analyst Two', role: 'analyst', password: process.env.T2W_PASS_ANALYST2?.trim() ?? '' },
]

function secret(): string {
  const s = process.env.AUTH_SECRET?.trim()
  if (!s) throw new Error('AUTH_SECRET is not configured — sessions cannot be signed or verified. Set it in the environment.')
  return s
}

const enc = new TextEncoder()

const b64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlDecode = (s: string): string =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/'))

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function sign(body: string): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body)))
}

export interface SessionPayload extends AuthUser {
  exp: number
}

export async function createToken(user: AuthUser, now = Date.now()): Promise<{ token: string; maxAge: number }> {
  const maxAge = SESSION_DAYS * 86_400
  const payload: SessionPayload = { ...user, exp: now + maxAge * 1000 }
  const body = b64url(JSON.stringify(payload))
  return { token: `${body}.${await sign(body)}`, maxAge }
}

export async function verifyToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return null
    const body = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = await sign(body)
    // constant-time-ish compare
    if (sig.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff !== 0) return null
    const payload = JSON.parse(b64urlDecode(body)) as SessionPayload
    if (!payload?.id || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    // NEVER throw from verification. A missing/empty AUTH_SECRET (secret()
    // throws), a malformed cookie or any crypto hiccup must degrade to
    // "not signed in" — an unhandled throw here happens inside the edge
    // middleware and takes the WHOLE site down with Vercel's
    // 500 MIDDLEWARE_INVOCATION_FAILED ("This page is unavailable").
    return null
  }
}

export function authenticate(username: string, password: string): AuthUser | null {
  const u = USERS.find((x) => x.username === username.trim().toLowerCase())
  if (!u || !u.password || u.password !== password) return null
  return { id: u.id, name: u.name, role: u.role }
}

export function userById(id: string): AuthUser | null {
  const u = USERS.find((x) => x.id === id)
  return u ? { id: u.id, name: u.name, role: u.role } : null
}
