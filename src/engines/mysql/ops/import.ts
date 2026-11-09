/**
 * Loads rows from a file into a MySQL table, all in one transaction. Batches first; if a batch is
 * refused it goes one row at a time to say which rows are wrong.
 */
import { z } from 'zod'
import { badRequest } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { databaseOf, tableMeta, withTx, type Conn } from '../conn.js'
import { quoteIdent } from '../sqlbuild.js'

const ident = z.string().min(1).max(64)
const MAX_REPORTED = 100
const MAX_PLACEHOLDERS = 65_535
const MAX_BATCH = 1000

const input = z.object({
  schema: ident.default('public'),
  table: ident,
  columns: z.array(ident).min(1).max(200),
  rows: z.array(z.array(z.string().nullable())).min(1).max(50_000),
  firstRow: z.number().int().min(1).default(2),
  skipBad: z.boolean().default(false),
})

export interface ImportOutcome {
  inserted: number
  skipped: number
  errors: { row: number; message: string }[]
  rolledBack: boolean
}

class Undo extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super('undo')
  }
}

/** CSV words for true and false, and the trailing Z MySQL refuses on a date. */
export function cellFor(type: string, value: string | null): string | null {
  if (value === null) return null
  const v = value.trim()
  if (/^tinyint\(1\)/i.test(type)) return /^(true|t|yes|y|on)$/i.test(v) ? '1' : /^(false|f|no|n|off)$/i.test(v) ? '0' : value
  if (/^(datetime|timestamp)/i.test(type)) return v.replace(/z$/i, '+00:00')
  return value
}

export const batchSize = (columns: number) => Math.min(MAX_BATCH, Math.floor(MAX_PLACEHOLDERS / columns))

async function loadRows(c: Conn, db: string, given: z.infer<typeof input>): Promise<ImportOutcome> {
  const meta = await tableMeta(c, db, given.table)
  const typeOf = given.columns.map((name) => meta.columns.find((x) => x.name === name)?.type ?? '')
  const req = { ...given, rows: given.rows.map((r) => r.map((v, i) => cellFor(typeOf[i] ?? '', v))) }
  if (new Set(req.columns).size !== req.columns.length) throw badRequest('A column was picked twice')
  for (const name of req.columns) if (!meta.columns.some((x) => x.name === name)) throw badRequest(`There is no column "${name}" in this table`)
  for (const r of req.rows) if (r.length !== req.columns.length) throw badRequest('Every row needs a value for every picked column')

  const head = `INSERT INTO ${quoteIdent(req.table)} (${req.columns.map(quoteIdent).join(', ')}) VALUES `
  const group = `(${req.columns.map(() => '?').join(', ')})`
  const size = batchSize(req.columns.length)
  let point = 0
  const attempt = async (sql: string, values: (string | null)[]): Promise<void> => {
    const name = `import_${point++}`
    await c.query(`SAVEPOINT ${name}`)
    try {
      await c.execute(sql, values)
      await c.query(`RELEASE SAVEPOINT ${name}`)
    } catch (e) {
      await c.query(`ROLLBACK TO SAVEPOINT ${name}`)
      throw e
    }
  }

  let bulkFailed = false
  let inserted = 0
  for (let i = 0; i < req.rows.length && !bulkFailed; i += size) {
    const batch = req.rows.slice(i, i + size)
    try {
      await attempt(head + batch.map(() => group).join(', '), batch.flat())
      inserted += batch.length
    } catch {
      bulkFailed = true
      // Something in the file does not fit; start over one row at a time to find out which rows.
      await c.query('ROLLBACK')
      await c.query('START TRANSACTION')
      inserted = 0
    }
  }
  if (!bulkFailed) return { inserted, skipped: 0, errors: [], rolledBack: false }

  const errors: ImportOutcome['errors'] = []
  let skipped = 0
  for (let i = 0; i < req.rows.length; i++) {
    try {
      await attempt(head + group, req.rows[i] as (string | null)[])
      inserted++
    } catch (e) {
      skipped++
      if (errors.length < MAX_REPORTED) errors.push({ row: req.firstRow + i, message: (e as { sqlMessage?: string; message?: string }).sqlMessage ?? 'This row could not be loaded' })
      if (!req.skipBad && errors.length >= MAX_REPORTED) break
    }
  }
  if (skipped > 0 && !req.skipBad) throw new Undo({ inserted: 0, skipped, errors, rolledBack: true })
  return { inserted, skipped, errors, rolledBack: false }
}

export const importRows: Op = {
  mode: 'write',
  input,
  async run({ claims, address, input: raw }) {
    const req = input.parse(raw)
    const db = databaseOf(claims, req.schema)
    try {
      return await withTx(claims, address, 'write', (c) => loadRows(c, db, req))
    } catch (e) {
      if (e instanceof Undo) return e.outcome
      throw e
    }
  },
}
