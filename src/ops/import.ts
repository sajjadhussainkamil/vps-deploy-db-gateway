/**
 * Loads rows from a file into an existing table, all in one transaction. The fast path is a single
 * INSERT … SELECT; if anything is wrong it falls back to one row at a time to say which rows.
 */
import { z } from 'zod'
import { tableMeta, withTx, type Tx } from '../db.js'
import { badRequest } from '../errors.js'
import { assertUserSchema, qualified } from '../sqlbuild.js'
import type { Op } from './types.js'

const ident = z.string().min(1).max(63)
const MAX_REPORTED = 100

const input = z.object({
  schema: ident.default('public'),
  table: ident,
  columns: z.array(ident).min(1).max(200),
  rows: z.array(z.array(z.string().nullable())).min(1).max(50_000),
  /** The file row number of the first row sent, so messages can say "row 41". */
  firstRow: z.number().int().min(1).default(2),
  skipBad: z.boolean().default(false),
})

export interface ImportOutcome {
  inserted: number
  skipped: number
  errors: { row: number; message: string }[]
  rolledBack: boolean
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Thrown inside the transaction to undo it while still returning the report. */
class Undo extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super('undo')
  }
}

async function loadRows(tx: Tx, req: z.infer<typeof input>): Promise<ImportOutcome> {
  assertUserSchema(req.schema)
  const meta = await tableMeta(tx, req.schema, req.table)
  if (new Set(req.columns).size !== req.columns.length) throw badRequest('A column was picked twice')
  const cols = req.columns.map((name) => {
    const c = meta.columns.find((x) => x.name === name)
    if (!c) throw badRequest(`There is no column "${name}" in this table`)
    return c
  })
  for (const r of req.rows) if (r.length !== cols.length) throw badRequest('Every row needs a value for every picked column')

  // Types come from the catalog, never from the request.
  const target = `INSERT INTO ${qualified(req.schema, req.table)} (${cols.map((c) => quoteIdent(c.name)).join(', ')})`
  const bulk = `${target} SELECT ${cols.map((c, i) => `u.c${i}::${c.type}`).join(', ')} FROM unnest(${cols.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${cols.map((_, i) => `c${i}`).join(', ')})`
  const columnsOfValues = cols.map((_, i) => req.rows.map((r) => r[i]))

  try {
    await tx.savepoint((sp) => sp.unsafe(bulk, columnsOfValues as never[]))
    return { inserted: req.rows.length, skipped: 0, errors: [], rolledBack: false }
  } catch {
    // Something in the file does not fit; find out which rows.
  }

  const one = `${target} VALUES (${cols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')})`
  const errors: ImportOutcome['errors'] = []
  let inserted = 0
  let skipped = 0
  for (let i = 0; i < req.rows.length; i++) {
    try {
      await tx.savepoint((sp) => sp.unsafe(one, req.rows[i] as never[]))
      inserted++
    } catch (e) {
      skipped++
      if (errors.length < MAX_REPORTED) errors.push({ row: req.firstRow + i, message: (e as { message?: string }).message ?? 'This row could not be loaded' })
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
    try {
      return await withTx(claims, address, 'write', (tx) => loadRows(tx, req))
    } catch (e) {
      if (e instanceof Undo) return e.outcome
      throw e
    }
  },
}
