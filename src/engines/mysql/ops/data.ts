/** Reading and changing rows in MySQL. Every name is checked against the table's real columns first. */
import { z } from 'zod'
import { badRequest } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { databaseOf, tableMeta, wire, withTx, type Conn, type Header, type Rows } from '../conn.js'
import { buildDelete, buildInsert, buildRows, buildSelectOne, buildUpdate, insertedKey, MAX_DELETE, MAX_LIMIT, type Filter, type TableMeta } from '../sqlbuild.js'

const ident = z.string().min(1).max(64)
const target = { schema: ident.default('public'), table: ident }

const filterSchema = z.object({
  col: ident,
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'in', 'is_null', 'not_null', 'contains']),
  val: z.unknown().optional(),
})

const rowsInput = z.object({
  ...target,
  columns: z.array(ident).max(200).optional(),
  filters: z.array(filterSchema).max(20).default([]),
  sort: z.array(z.object({ col: ident, dir: z.enum(['asc', 'desc']).default('asc') })).max(5).default([]),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(100),
  exactCount: z.boolean().default(false),
})

const bound = (params: unknown[]) => params as (string | number | null)[]

export const rows: Op = {
  mode: 'read',
  input: rowsInput,
  async run({ claims, address, input }) {
    const req = rowsInput.parse(input)
    const db = databaseOf(claims, req.schema)
    return withTx(claims, address, 'read', async (c) => {
      const meta = await tableMeta(c, db, req.table)
      const built = buildRows({ ...req, filters: req.filters as Filter[] }, meta)
      const [fetched] = await c.execute<Rows>(built.page.text, bound(built.page.params))
      const hasMore = fetched.length > req.limit
      const page = wire(fetched.slice(0, req.limit))

      let count: { value: number; exact: boolean }
      if (req.exactCount) {
        const [n] = await c.execute<Rows>(built.count.text, bound(built.count.params))
        count = { value: Number(n[0]?.n ?? 0), exact: true }
      } else {
        const [e] = await c.execute<Rows>('SELECT COALESCE(TABLE_ROWS, 0) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, req.table])
        count = { value: Number(e[0]?.n ?? 0), exact: false }
      }
      return {
        rows: page,
        columns: meta.columns.map((col) => ({ name: col.name, type: col.type, isPk: meta.pk.includes(col.name) })),
        primaryKey: meta.pk,
        nextOffset: hasMore ? req.offset + req.limit : null,
        count,
      }
    })
  },
}

async function readBack(c: Conn, table: string, key: Record<string, unknown>, meta: TableMeta): Promise<Record<string, unknown> | undefined> {
  const q = buildSelectOne(table, key, meta)
  const [found] = await c.execute<Rows>(q.text, bound(q.params))
  return wire(found.slice(0, 1))[0]
}

const insertInput = z.object({ ...target, values: z.record(z.string(), z.unknown()).default({}) })

export const insert: Op = {
  mode: 'write',
  input: insertInput,
  async run({ claims, address, input }) {
    const req = insertInput.parse(input)
    const db = databaseOf(claims, req.schema)
    return withTx(claims, address, 'write', async (c) => {
      const meta = await tableMeta(c, db, req.table)
      const q = buildInsert(req.table, req.values, meta)
      const [result] = await c.execute<Header>(q.text, bound(q.params))
      const key = insertedKey(req.values, meta, result.insertId)
      // A key MySQL generated from an expression cannot be asked for afterwards.
      return { row: (key ? await readBack(c, req.table, key, meta) : undefined) ?? wire([req.values])[0] }
    })
  },
}

const updateInput = z.object({ ...target, pk: z.record(z.string(), z.unknown()), set: z.record(z.string(), z.unknown()) })

export const update: Op = {
  mode: 'write',
  input: updateInput,
  async run({ claims, address, input }) {
    const req = updateInput.parse(input)
    const db = databaseOf(claims, req.schema)
    return withTx(claims, address, 'write', async (c) => {
      const meta = await tableMeta(c, db, req.table)
      const q = buildUpdate(req.table, req.pk, req.set, meta)
      const [result] = await c.execute<Header>(q.text, bound(q.params))
      // The driver reports rows matched, so an update that changes nothing still counts as found.
      if (result.affectedRows === 0) throw badRequest('That row no longer exists')
      const key = Object.fromEntries(meta.pk.map((k) => [k, k in req.set ? req.set[k] : req.pk[k]]))
      return { row: (await readBack(c, req.table, key, meta)) ?? null }
    })
  },
}

const deleteInput = z.object({ ...target, pks: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_DELETE) })

export const remove: Op = {
  mode: 'write',
  input: deleteInput,
  async run({ claims, address, input }) {
    const req = deleteInput.parse(input)
    const db = databaseOf(claims, req.schema)
    return withTx(claims, address, 'write', async (c) => {
      const meta = await tableMeta(c, db, req.table)
      const q = buildDelete(req.table, req.pks, meta)
      const [result] = await c.execute<Header>(q.text, bound(q.params))
      return { deleted: result.affectedRows }
    })
  },
}
