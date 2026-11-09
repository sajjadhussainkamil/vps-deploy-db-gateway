/**
 * Verifies the platform's short-lived bearer token. HS256 with a per-server secret, 60 seconds
 * at most, each token usable once. Nothing is read from the token until the signature is right.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { forbidden } from './errors.js'

const targetSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int(),
  db: z.string().min(1).max(64),
  user: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
})
export type Target = z.infer<typeof targetSchema>

const claimsSchema = z.object({
  iss: z.literal('platform'),
  aud: z.string(),
  sub: z.string().min(1).max(64),
  op: z.string().min(1).max(32),
  iat: z.number(),
  exp: z.number(),
  jti: z.string().min(8).max(64),
  engine: z.enum(['postgresql', 'mysql']).default('postgresql'),
  target: targetSchema,
  // The app role, so a stats call can see what a fresh application session would see.
  probe: targetSchema.pick({ user: true, password: true }).optional(),
  readOnly: z.boolean().default(true),
  limits: z
    .object({
      timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      maxRows: z.number().int().min(1).max(5_000).default(500),
      maxBytes: z.number().int().min(1_024).max(104_857_600).default(5_242_880),
    })
    .default({}),
  actor: z.object({ id: z.string(), audience: z.string() }).optional(),
  recoveryOnly: z.boolean().optional(),
  // A backup file for restore and download, and the database it belongs to (its 24-character Coolify uuid).
  file: z.object({ path: z.string().min(1).max(1024), owner: z.string().regex(/^[a-z0-9]{24}$/) }).optional(),
  // The most a customer's backup file may weigh when it is sent in.
  upload: z.object({ maxBytes: z.number().int().min(1).max(21_474_836_480), bytes: z.number().int().min(1).max(21_474_836_480).optional() }).optional(),
})
export type Claims = z.infer<typeof claimsSchema>

export const MAX_TOKEN_LIFETIME_S = 60
const SKEW_S = 5
const JTI_TTL_MS = 90_000
const JTI_MAX = 10_000

const seen = new Map<string, number>()

/** Remember a token id; false when it was already used. Oldest entries go first. */
function remember(jti: string, now: number): boolean {
  for (const [id, at] of seen) {
    if (now - at > JTI_TTL_MS || seen.size > JTI_MAX) seen.delete(id)
    else break
  }
  if (seen.has(jti)) return false
  seen.set(jti, now)
  return true
}

export function resetReplayCache(): void {
  seen.clear()
}

const b64 = (s: string) => Buffer.from(s, 'base64url')

export interface VerifyOptions {
  secret: string
  audience: string
  /** Injectable clock, in milliseconds. */
  now?: number
  allowedOps: ReadonlySet<string>
}

export function verifyToken(token: string, opts: VerifyOptions): Claims {
  const parts = token.split('.')
  if (parts.length !== 3) throw forbidden('Invalid token')
  const [h, p, s] = parts as [string, string, string]

  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(b64(h).toString('utf8'))
  } catch {
    throw forbidden('Invalid token')
  }
  if (header.alg !== 'HS256') throw forbidden('Invalid token')

  const expected = createHmac('sha256', opts.secret).update(`${h}.${p}`).digest()
  const given = b64(s)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('Invalid token')

  let claims: Claims
  try {
    claims = claimsSchema.parse(JSON.parse(b64(p).toString('utf8')))
  } catch {
    throw forbidden('Invalid token')
  }

  const now = opts.now ?? Date.now()
  const nowS = Math.floor(now / 1000)
  if (claims.aud !== opts.audience) throw forbidden('Invalid token')
  if (claims.exp < nowS - SKEW_S) throw forbidden('Token expired')
  if (claims.iat > nowS + SKEW_S) throw forbidden('Invalid token')
  if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_S + SKEW_S) throw forbidden('Token lives too long')
  if (!opts.allowedOps.has(claims.op)) throw forbidden('Operation not allowed')
  if (!remember(claims.jti, now)) throw forbidden('Token already used')
  return claims
}
