import type { z } from 'zod'
import type { Claims } from '../token.js'

export interface OpCtx {
  claims: Claims
  /** The checked address to connect to, not the name from the token. */
  address: string
  /** Already validated against the op's schema. */
  input: unknown
}

/** `write` changes customer data and needs a token that allows it; `admin` is the platform's own upkeep. */
export interface Op {
  mode: 'read' | 'write' | 'admin'
  input: z.ZodTypeAny
  run(ctx: OpCtx): Promise<unknown>
}
