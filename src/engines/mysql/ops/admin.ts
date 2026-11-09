/** The platform's own upkeep for MySQL: accounts, the server-wide read-only lock, limits, reclaiming space. */
import { z } from 'zod'
import { GatewayError, badRequest } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { mysqlBootstrapStatements, quoteAccount } from '../bootstrap-sql.js'
import { databaseOf, open, withConn, type Rows } from '../conn.js'
import { quoteIdent } from '../sqlbuild.js'

const user = z.string().min(1).max(32)

const STARTING = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET'])

const bootstrapInput = z.object({
  appUser: user,
  appPassword: z.string().min(16).max(512),
  maintUser: user,
  maintPassword: z.string().min(16).max(512),
  maxUserConnections: z.number().int().min(1).max(10_000),
})

export const bootstrap: Op = {
  mode: 'admin',
  input: bootstrapInput,
  async run({ claims, address, input }) {
    const req = bootstrapInput.parse(input)
    // Coolify can report healthy while the first-boot server is not yet listening on the network.
    const c = await open(claims, address).catch((e: { code?: string }) => {
      if (e?.code && STARTING.has(e.code)) throw new GatewayError(409, 'target_starting', 'The database is still starting')
      throw e
    })
    try {
      for (const stmt of mysqlBootstrapStatements({ ...req, dbName: claims.target.db })) await c.query(stmt)
      return { created: true }
    } finally {
      c.destroy()
    }
  },
}

const lockInput = z.object({ appUser: user })

/** Ends the application's open transactions first; otherwise the lock waits for them or fails. */
export const lock: Op = {
  mode: 'admin',
  input: lockInput,
  async run({ claims, address, input }) {
    const { appUser } = lockInput.parse(input)
    return withConn(claims, address, async (c) => {
      await c.query('SET SESSION lock_wait_timeout = 10')
      const [open_] = await c.execute<Rows>(
        `SELECT t.trx_mysql_thread_id AS id FROM information_schema.INNODB_TRX t
           JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id WHERE p.USER = ?`,
        [appUser]
      )
      for (const r of open_) await c.query(`KILL ${Math.trunc(Number(r.id))}`).catch(() => undefined)
      await c.query('SET PERSIST read_only = ON')
      return { locked: true, terminated: open_.length }
    })
  },
}

export const unlock: Op = {
  mode: 'admin',
  input: lockInput,
  async run({ claims, address }) {
    return withConn(claims, address, async (c) => {
      await c.query('RESET PERSIST IF EXISTS read_only')
      await c.query('SET GLOBAL read_only = OFF')
      return { locked: false }
    })
  },
}

const limitsInput = z.object({
  redoBytes: z.number().int().min(8 * 2 ** 20).max(128 * 2 ** 30),
  undoBytes: z.number().int().min(10 * 2 ** 20).max(128 * 2 ** 30),
})

/** Changes the limits on the running server; the settings file Coolify holds carries them across restarts. */
export const applyLimits: Op = {
  mode: 'admin',
  input: limitsInput,
  async run({ claims, address, input }) {
    const req = limitsInput.parse(input)
    return withConn(claims, address, async (c) => {
      await c.query(`SET GLOBAL innodb_redo_log_capacity = ${req.redoBytes}, innodb_max_undo_log_size = ${req.undoBytes}`)
      return { ok: true }
    })
  },
}

export const accountUnlock: Op = {
  mode: 'admin',
  input: lockInput,
  async run({ claims, address, input }) {
    const { appUser } = lockInput.parse(input)
    return withConn(claims, address, async (c) => {
      await c.query(`ALTER USER ${quoteAccount(appUser)} ACCOUNT UNLOCK`)
      return { unlocked: true }
    })
  },
}

const optimizeInput = z.object({ table: z.string().min(1).max(64).optional(), roomBytes: z.number().int().min(0) })
const LARGEST = 5

/** Rebuilds tables so deleted rows go back to the disk. A rebuild briefly needs room for a whole copy. */
export const optimize: Op = {
  mode: 'admin',
  input: optimizeInput,
  async run({ claims, address, input }) {
    const req = optimizeInput.parse(input)
    const db = databaseOf(claims)
    return withConn(claims, address, async (c) => {
      const size = 'COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) + COALESCE(DATA_FREE, 0)'
      const measure = async (name: string) => {
        const [r] = await c.execute<Rows>(`SELECT ${size} AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [db, name])
        return Number(r[0]?.n ?? 0)
      }
      let names: string[]
      if (req.table) {
        const [found] = await c.execute<Rows>(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'`, [db, req.table])
        if (found.length === 0) throw badRequest(`There is no table "${req.table}"`)
        names = [req.table]
      } else {
        const [big] = await c.execute<Rows>(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND DATA_FREE > 0 ORDER BY DATA_FREE DESC LIMIT ${LARGEST}`, [db])
        names = big.map((t) => String(t.name))
      }

      const tables: { name: string; before: number; after: number }[] = []
      for (const name of names) {
        const before = await measure(name)
        if (before > req.roomBytes) {
          if (tables.length === 0) throw new GatewayError(409, 'no_room', `"${name}" needs ${Math.ceil(before / 2 ** 20)} MB of free space to be rebuilt, and there is not enough. Add storage first.`)
          break
        }
        const [out] = await c.query<Rows>(`OPTIMIZE TABLE ${quoteIdent(name)}`)
        const failed = out.find((r) => String(r.Msg_type).toLowerCase() === 'error')
        if (failed) throw badRequest(String(failed.Msg_text))
        tables.push({ name, before, after: await measure(name) })
      }
      return { tables, reclaimedBytes: tables.reduce((n, t) => n + Math.max(0, t.before - t.after), 0) }
    })
  },
}
