/**
 * Builds the SQL for structured operations. Identifiers are checked against the table's real
 * columns and then quoted; values are always bound parameters. Nothing a caller sends is ever
 * concatenated into a statement.
 */
import { badRequest } from './errors.js'

export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

export interface ColumnMeta {
  name: string
  type: string
  notNull: boolean
  hasDefault: boolean
}
export interface TableMeta {
  columns: ColumnMeta[]
  pk: string[]
}

export type FilterOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'in' | 'is_null' | 'not_null' | 'contains'
export interface Filter {
  col: string
  op: FilterOp
  val?: unknown
}
export interface Sort {
  col: string
  dir: 'asc' | 'desc'
}
export interface RowsRequest {
  schema: string
  table: string
  columns?: string[]
  filters: Filter[]
  sort: Sort[]
  offset: number
  limit: number
}

export const MAX_LIMIT = 500
export const MAX_IN_VALUES = 200
export const MAX_DELETE = 500

/** System schemas are never browsable. */
export function assertUserSchema(schema: string): void {
  if (schema.startsWith('pg_') || schema === 'information_schema') throw badRequest('That schema is not available')
}

export const qualified = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`

type Kind = 'bool' | 'int' | 'num' | 'json' | 'text'

export function kindOf(pgType: string): Kind {
  const t = pgType.toLowerCase()
  if (t === 'boolean') return 'bool'
  if (/^(smallint|integer|bigint)$/.test(t)) return 'int'
  if (/^(numeric|decimal|real|double precision)/.test(t)) return 'num'
  if (t === 'json' || t === 'jsonb') return 'json'
  return 'text'
}

/** Make a JS value acceptable to the column's type, or say why not. Strings stay strings. */
export function coerce(value: unknown, pgType: string, colName: string): unknown {
  if (value === null || value === undefined) return null
  const kind = kindOf(pgType)
  if (kind === 'bool') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 't') return true
    if (value === 'false' || value === 'f') return false
    throw badRequest(`"${colName}" needs true or false`)
  }
  if (kind === 'int' || kind === 'num') {
    const s = typeof value === 'number' ? String(value) : String(value).trim()
    const re = kind === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?([eE][+-]?\d+)?$|^NaN$|^-?Infinity$/
    if (!re.test(s)) throw badRequest(`"${colName}" needs a number`)
    return s
  }
  if (kind === 'json') return typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof value === 'object') throw badRequest(`"${colName}" needs text`)
  return String(value)
}

function column(meta: TableMeta, name: string): ColumnMeta {
  const c = meta.columns.find((x) => x.name === name)
  if (!c) throw badRequest(`There is no column "${name}" in this table`)
  return c
}

export interface Built {
  text: string
  params: unknown[]
}

function predicate(f: Filter, meta: TableMeta, params: unknown[]): string {
  const c = column(meta, f.col)
  const id = quoteIdent(c.name)
  const bind = (v: unknown) => {
    params.push(v)
    return `$${params.length}`
  }
  switch (f.op) {
    case 'is_null':
      return `${id} IS NULL`
    case 'not_null':
      return `${id} IS NOT NULL`
    case 'eq':
      return f.val === null ? `${id} IS NULL` : `${id} = ${bind(coerce(f.val, c.type, c.name))}`
    case 'neq':
      return f.val === null ? `${id} IS NOT NULL` : `${id} <> ${bind(coerce(f.val, c.type, c.name))}`
    case 'lt':
      return `${id} < ${bind(coerce(f.val, c.type, c.name))}`
    case 'lte':
      return `${id} <= ${bind(coerce(f.val, c.type, c.name))}`
    case 'gt':
      return `${id} > ${bind(coerce(f.val, c.type, c.name))}`
    case 'gte':
      return `${id} >= ${bind(coerce(f.val, c.type, c.name))}`
    case 'like':
    case 'ilike': {
      if (typeof f.val !== 'string') throw badRequest('Text search needs text')
      return `${id}::text ${f.op === 'like' ? 'LIKE' : 'ILIKE'} ${bind(f.val)}`
    }
    case 'in': {
      if (!Array.isArray(f.val) || f.val.length === 0 || f.val.length > MAX_IN_VALUES) {
        throw badRequest(`"in" needs 1 to ${MAX_IN_VALUES} values`)
      }
      return `${id}::text = ANY(${bind(f.val.map((v) => String(v)))}::text[])`
    }
    case 'contains': {
      if (kindOf(c.type) !== 'json') throw badRequest(`"${c.name}" is not a JSON column`)
      return `${id}::jsonb @> ${bind(JSON.stringify(f.val))}::jsonb`
    }
    default:
      throw badRequest('Unknown filter')
  }
}

export function buildWhere(filters: Filter[], meta: TableMeta, params: unknown[]): string {
  return filters.length ? ` WHERE ${filters.map((f) => predicate(f, meta, params)).join(' AND ')}` : ''
}

/** One page of rows, plus one extra so the caller knows whether another page exists. */
export function buildRows(req: RowsRequest, meta: TableMeta): { page: Built; count: Built } {
  assertUserSchema(req.schema)
  const cols = req.columns?.length ? req.columns.map((n) => quoteIdent(column(meta, n).name)).join(', ') : '*'

  const params: unknown[] = []
  const where = buildWhere(req.filters, meta, params)
  const countParams = [...params]

  // A stable order matters more than a nice one: without it, pages overlap or skip rows.
  const sort = req.sort.length
    ? req.sort.map((s) => `${quoteIdent(column(meta, s.col).name)} ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`)
    : meta.pk.map((k) => quoteIdent(k))
  const order = sort.length ? ` ORDER BY ${sort.join(', ')}` : ''

  const limit = Math.min(Math.max(Math.trunc(req.limit), 1), MAX_LIMIT)
  const offset = Math.max(Math.trunc(req.offset), 0)
  const from = qualified(req.schema, req.table)

  return {
    page: { text: `SELECT ${cols} FROM ${from}${where}${order} LIMIT ${limit + 1} OFFSET ${offset}`, params },
    count: { text: `SELECT count(*)::text AS n FROM ${from}${where}`, params: countParams },
  }
}

export function buildInsert(schema: string, table: string, values: Record<string, unknown>, meta: TableMeta): Built {
  assertUserSchema(schema)
  const names = Object.keys(values)
  const from = qualified(schema, table)
  if (names.length === 0) return { text: `INSERT INTO ${from} DEFAULT VALUES RETURNING *`, params: [] }
  const params = names.map((n) => {
    const c = column(meta, n)
    return coerce(values[n], c.type, c.name)
  })
  const cols = names.map((n) => quoteIdent(n)).join(', ')
  const marks = names.map((_, i) => `$${i + 1}`).join(', ')
  return { text: `INSERT INTO ${from} (${cols}) VALUES (${marks}) RETURNING *`, params }
}

function pkWhere(pk: Record<string, unknown>, meta: TableMeta, params: unknown[]): string {
  if (meta.pk.length === 0) throw badRequest('This table has no primary key, so rows cannot be changed here')
  const keys = Object.keys(pk)
  if (keys.length !== meta.pk.length || !meta.pk.every((k) => keys.includes(k))) {
    throw badRequest('Give the full primary key')
  }
  return meta.pk
    .map((k) => {
      const c = column(meta, k)
      params.push(coerce(pk[k], c.type, c.name))
      return `${quoteIdent(k)} = $${params.length}`
    })
    .join(' AND ')
}

export function buildUpdate(
  schema: string,
  table: string,
  pk: Record<string, unknown>,
  set: Record<string, unknown>,
  meta: TableMeta
): Built {
  assertUserSchema(schema)
  const names = Object.keys(set)
  if (names.length === 0) throw badRequest('Nothing to change')
  const params: unknown[] = []
  const sets = names.map((n) => {
    const c = column(meta, n)
    params.push(coerce(set[n], c.type, c.name))
    return `${quoteIdent(n)} = $${params.length}`
  })
  const where = pkWhere(pk, meta, params)
  return { text: `UPDATE ${qualified(schema, table)} SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params }
}

export function buildDelete(schema: string, table: string, pks: Record<string, unknown>[], meta: TableMeta): Built {
  assertUserSchema(schema)
  if (pks.length === 0) throw badRequest('Nothing to delete')
  if (pks.length > MAX_DELETE) throw badRequest(`Delete at most ${MAX_DELETE} rows at once`)
  const params: unknown[] = []
  const clauses = pks.map((pk) => `(${pkWhere(pk, meta, params)})`)
  return { text: `DELETE FROM ${qualified(schema, table)} WHERE ${clauses.join(' OR ')}`, params }
}
