/** The platform's own upkeep: creating the app role, the read-only lock, and VACUUM. */
import { z } from 'zod'
import { bootstrapPlan, quoteIdent } from '../bootstrap-sql.js'
import { tableMeta, withConn, withTx } from '../db.js'
import { assertUserSchema, qualified } from '../sqlbuild.js'
import type { Op } from './types.js'

const bootstrapInput = z.object({
  appUser: z.string().min(1).max(63),
  appPassword: z.string().min(16).max(512),
  extensions: z.array(z.string().max(63)).max(20).default([]),
})

export const bootstrap: Op = {
  mode: 'admin',
  input: bootstrapInput,
  async run({ claims, address, input }) {
    const req = bootstrapInput.parse(input)
    const plan = bootstrapPlan({ dbName: claims.target.db, appUser: req.appUser, appPassword: req.appPassword, extensions: req.extensions })
    // One transaction: a half-bootstrapped database is worse than none.
    return withTx(claims, address, 'write', async (tx) => {
      const exists = await tx.unsafe(plan.roleExists)
      await tx.unsafe(exists.length ? plan.alterRole : plan.createRole)
      for (const stmt of plan.after) await tx.unsafe(stmt)
      return { created: exists.length === 0 }
    })
  },
}

const lockInput = z.object({ appUser: z.string().min(1).max(63) })

/** Make new sessions read-only at both database and role level, and drop idle open transactions. */
export const lock: Op = {
  mode: 'admin',
  input: lockInput,
  async run({ claims, address, input }) {
    const { appUser } = lockInput.parse(input)
    return withConn(claims, address, async (sql) => {
      await sql.unsafe(`ALTER DATABASE ${quoteIdent(claims.target.db)} SET default_transaction_read_only = on`)
      await sql.unsafe(`ALTER ROLE ${quoteIdent(appUser)} SET default_transaction_read_only = on`)
      const ended = await sql`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE usename = ${appUser} AND state = 'idle in transaction' AND pid <> pg_backend_pid()`
      return { locked: true, terminated: ended.count }
    })
  },
}

export const unlock: Op = {
  mode: 'admin',
  input: lockInput,
  async run({ claims, address, input }) {
    const { appUser } = lockInput.parse(input)
    return withConn(claims, address, async (sql) => {
      await sql.unsafe(`ALTER DATABASE ${quoteIdent(claims.target.db)} RESET default_transaction_read_only`)
      await sql.unsafe(`ALTER ROLE ${quoteIdent(appUser)} RESET default_transaction_read_only`)
      return { locked: false }
    })
  },
}

const vacuumInput = z.object({ schema: z.string().min(1).max(63).default('public'), table: z.string().min(1).max(63) })

export const vacuum: Op = {
  mode: 'admin',
  input: vacuumInput,
  async run({ claims, address, input }) {
    const req = vacuumInput.parse(input)
    assertUserSchema(req.schema)
    // The name is proven to be a real table before it is quoted into a statement.
    await withTx(claims, address, 'read', (tx) => tableMeta(tx, req.schema, req.table))
    return withConn(claims, address, async (sql) => {
      await sql.unsafe(`VACUUM (ANALYZE) ${qualified(req.schema, req.table)}`)
      return { ok: true }
    })
  },
}
