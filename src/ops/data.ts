/** Reading and changing rows. Every name is checked against the table's real columns first. */
import { z } from 'zod'
import { tableMeta, withTx, wire } from '../db.js'
import { badRequest } from '../errors.js'
import { buildDelete, buildInsert, buildRows, buildUpdate, MAX_DELETE, MAX_LIMIT, type Filter } from '../sqlbuild.js'
import type { Op } from './types.js'

const ident = z.string().min(1).max(63)
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

export const rows: Op = {
  mode: 'read',
  input: rowsInput,
  async run({ claims, address, input }) {
    const req = rowsInput.parse(input)
    return withTx(claims, address, 'read', async (tx) => {
      const meta = await tableMeta(tx, req.schema, req.table)
      const built = buildRows({ ...req, filters: req.filters as Filter[] }, meta)
      const fetched = await tx.unsafe(built.page.text, built.page.params as never[])
      const hasMore = fetched.length > req.limit
      const page = wire(fetched.slice(0, req.limit))

      // A count of a big table is slow, so the estimate is the default and the exact count is asked for.
      let count: { value: number; exact: boolean }
      if (req.exactCount) {
        const [c] = await tx.unsafe(built.count.text, built.count.params as never[])
        count = { value: Number((c as unknown as { n: string }).n), exact: true }
      } else {
        const [e] = await tx<{ n: string }[]>`
          SELECT greatest(c.reltuples, 0)::bigint::text AS n FROM pg_class c
            JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = ${req.schema} AND c.relname = ${req.table}`
        count = { value: Number(e?.n ?? 0), exact: false }
      }
      return {
        rows: page,
        columns: meta.columns.map((c) => ({ name: c.name, type: c.type, isPk: meta.pk.includes(c.name) })),
        primaryKey: meta.pk,
        nextOffset: hasMore ? req.offset + req.limit : null,
        count,
      }
    })
  },
}

const insertInput = z.object({ ...target, values: z.record(z.string(), z.unknown()).default({}) })

export const insert: Op = {
  mode: 'write',
  input: insertInput,
  async run({ claims, address, input }) {
    const req = insertInput.parse(input)
    return withTx(claims, address, 'write', async (tx) => {
      const meta = await tableMeta(tx, req.schema, req.table)
      const q = buildInsert(req.schema, req.table, req.values, meta)
      const [row] = await tx.unsafe(q.text, q.params as never[])
      return { row: wire([row as Record<string, unknown>])[0] }
    })
  },
}

const updateInput = z.object({
  ...target,
  pk: z.record(z.string(), z.unknown()),
  set: z.record(z.string(), z.unknown()),
})

export const update: Op = {
  mode: 'write',
  input: updateInput,
  async run({ claims, address, input }) {
    const req = updateInput.parse(input)
    return withTx(claims, address, 'write', async (tx) => {
      const meta = await tableMeta(tx, req.schema, req.table)
      const q = buildUpdate(req.schema, req.table, req.pk, req.set, meta)
      const result = await tx.unsafe(q.text, q.params as never[])
      if (result.length === 0) throw badRequest('That row no longer exists')
      return { row: wire([result[0] as Record<string, unknown>])[0] }
    })
  },
}

const deleteInput = z.object({ ...target, pks: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_DELETE) })

export const remove: Op = {
  mode: 'write',
  input: deleteInput,
  async run({ claims, address, input }) {
    const req = deleteInput.parse(input)
    return withTx(claims, address, 'write', async (tx) => {
      const meta = await tableMeta(tx, req.schema, req.table)
      const q = buildDelete(req.schema, req.table, req.pks, meta)
      const result = await tx.unsafe(q.text, q.params as never[])
      return { deleted: result.count }
    })
  },
}
