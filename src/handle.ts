/**
 * Runs one request: verify the token, check the target, validate the input, run the operation.
 * Kept free of HTTP so every refusal can be tested without a server or a database.
 */
import { forbidden, toWire, badRequest, GatewayError, type WireError } from './errors.js'
import { ALLOWED_OPS, OPS } from './ops/index.js'
import { assertRecoveryAllowed } from './recovery.js'
import { assertTargetAllowed, type TargetPolicy } from './target.js'
import { verifyToken } from './token.js'

export interface HandlerConfig {
  secret: string
  /** The server this gateway belongs to; a token minted for another server is refused. */
  audience: string
  policy?: TargetPolicy
  now?: () => number
  log?: (line: Record<string, unknown>) => void
}

export type Outcome = { ok: true; data: unknown; sub: string } | { ok: false; status: number; error: WireError; sub?: string }

export async function handle(token: string, input: unknown, cfg: HandlerConfig): Promise<Outcome> {
  const started = Date.now()
  let sub: string | undefined
  let op = 'unknown'
  try {
    const claims = verifyToken(token, { secret: cfg.secret, audience: cfg.audience, allowedOps: ALLOWED_OPS, now: cfg.now?.() })
    sub = claims.sub
    op = claims.op
    const def = OPS[claims.op]
    if (!def) throw forbidden('Operation not allowed')
    if (def.mode === 'write' && claims.readOnly) throw new GatewayError(403, 'read_only_mode', 'Writing is switched off for this request')

    // After the signature and before any connection: a forged or stolen token cannot aim the gateway elsewhere.
    const address = await assertTargetAllowed(claims.target, cfg.policy)

    const parsed = def.input.safeParse(input ?? {})
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request')

    if (claims.recoveryOnly) assertRecoveryAllowed(claims.op, parsed.data)

    const data = await def.run({ claims, address, input: parsed.data })
    const size = Buffer.byteLength(JSON.stringify(data ?? null))
    if (size > claims.limits.maxBytes) {
      throw new GatewayError(413, 'too_large', 'That result is too large. Narrow it with a filter or a smaller page.')
    }
    cfg.log?.({ ts: new Date().toISOString(), op, dbId: sub, ms: Date.now() - started, ok: true })
    return { ok: true, data, sub }
  } catch (err) {
    const wire = toWire(err)
    // Only the operation, the database id and a code are logged: never a target, a token, SQL or rows.
    cfg.log?.({ ts: new Date().toISOString(), op, dbId: sub, ms: Date.now() - started, ok: false, code: wire.error.code })
    return { ok: false, status: wire.status, error: wire.error, sub }
  }
}
