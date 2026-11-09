/**
 * Builds MySQL for structured operations. Identifiers are checked against the table's real columns
 * and then quoted; values are always bound parameters.
 */
import { badRequest } from '../../errors.js'

export const quoteIdent = (name: string) => `\`${name.replace(/`/g, '``')}\``

export interface ColumnMeta {
  name: string
  type: string
  notNull: boolean
  hasDefault: boolean
  auto: boolean
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
  table: string
  columns?: string[]
  filters: Filter[]
  sort: Sort[]
  offset: number
  limit: number
}
export interface Built {
  text: string
  params: unknown[]
}

export const MAX_LIMIT = 500
export const MAX_IN_VALUES = 200
export const MAX_DELETE = 500

type Kind = 'bool' | 'int' | 'num' | 'json' | 'text'

export function kindOf(type: string): Kind {
  const t = type.toLowerCase()
  if (t === 'tinyint(1)' || t === 'boolean' || t === 'bool') return 'bool'
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|year)\b/.test(t)) return 'int'
  if (/^(decimal|numeric|float|double|real)\b/.test(t)) return 'num'
  if (t === 'json') return 'json'
  return 'text'
}

/** Make a JS value acceptable to the column's type, or say why not. */
export function coerce(value: unknown, type: string, colName: string): string | number | null {
  if (value === null || value === undefined) return null
  const kind = kindOf(type)
  if (kind === 'bool') {
    if (value === true || value === 'true' || value === 't' || value === 1 || value === '1') return 1
    if (value === false || value === 'false' || value === 'f' || value === 0 || value === '0') return 0
    throw badRequest(`"${colName}" needs true or false`)
  }
  if (kind === 'int' || kind === 'num') {
    const s = String(value).trim()
    const re = kind === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
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

function predicate(f: Filter, meta: TableMeta, params: unknown[]): string {
  const c = column(meta, f.col)
  const id = quoteIdent(c.name)
  const bind = (v: unknown) => {
    params.push(v)
    return '?'
  }
  const cmp = (sym: string) => `${id} ${sym} ${bind(coerce(f.val, c.type, c.name))}`
  switch (f.op) {
    case 'is_null':
      return `${id} IS NULL`
    case 'not_null':
      return `${id} IS NOT NULL`
    case 'eq':
      return f.val === null ? `${id} IS NULL` : cmp('=')
    case 'neq':
      return f.val === null ? `${id} IS NOT NULL` : cmp('<>')
    case 'lt':
      return cmp('<')
    case 'lte':
      return cmp('<=')
    case 'gt':
      return cmp('>')
    case 'gte':
      return cmp('>=')
    case 'like':
      if (typeof f.val !== 'string') throw badRequest('Text search needs text')
      return `CAST(${id} AS CHAR) LIKE ${bind(f.val)}`
    case 'ilike':
      if (typeof f.val !== 'string') throw badRequest('Text search needs text')
      return `LOWER(CAST(${id} AS CHAR)) LIKE LOWER(${bind(f.val)})`
    case 'in': {
      if (!Array.isArray(f.val) || f.val.length === 0 || f.val.length > MAX_IN_VALUES) throw badRequest(`"in" needs 1 to ${MAX_IN_VALUES} values`)
      return `CAST(${id} AS CHAR) IN (${f.val.map((v) => bind(String(v))).join(', ')})`
    }
    case 'contains':
      if (kindOf(c.type) !== 'json') throw badRequest(`"${c.name}" is not a JSON column`)
      return `JSON_CONTAINS(${id}, CAST(${bind(JSON.stringify(f.val))} AS JSON))`
    default:
      throw badRequest('Unknown filter')
  }
}

export function buildWhere(filters: Filter[], meta: TableMeta, params: unknown[]): string {
  return filters.length ? ` WHERE ${filters.map((f) => predicate(f, meta, params)).join(' AND ')}` : ''
}

/** One page of rows, plus one extra so the caller knows whether another page exists. */
export function buildRows(req: RowsRequest, meta: TableMeta): { page: Built; count: Built } {
  const cols = req.columns?.length ? req.columns.map((n) => quoteIdent(column(meta, n).name)).join(', ') : '*'
  const params: unknown[] = []
  const where = buildWhere(req.filters, meta, params)
  const countParams = [...params]

  // A stable order matters more than a nice one: without it, pages overlap or skip rows.
  const sort = req.sort.length
    ? req.sort.map((s) => {
        const id = quoteIdent(column(meta, s.col).name)
        return `${id} IS NULL, ${id} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`
      })
    : meta.pk.map((k) => quoteIdent(k))
  const order = sort.length ? ` ORDER BY ${sort.join(', ')}` : ''

  // Whole numbers checked here, because a bound LIMIT is unreliable in prepared statements.
  const limit = Math.min(Math.max(Math.trunc(req.limit), 1), MAX_LIMIT)
  const offset = Math.max(Math.trunc(req.offset), 0)
  const from = quoteIdent(req.table)
  return {
    page: { text: `SELECT ${cols} FROM ${from}${where}${order} LIMIT ${limit + 1} OFFSET ${offset}`, params },
    count: { text: `SELECT COUNT(*) AS n FROM ${from}${where}`, params: countParams },
  }
}

export function buildInsert(table: string, values: Record<string, unknown>, meta: TableMeta): Built {
  const names = Object.keys(values)
  if (names.length === 0) return { text: `INSERT INTO ${quoteIdent(table)} () VALUES ()`, params: [] }
  const params = names.map((n) => {
    const c = column(meta, n)
    return coerce(values[n], c.type, c.name)
  })
  return { text: `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, params }
}

function pkWhere(pk: Record<string, unknown>, meta: TableMeta, params: unknown[]): string {
  if (meta.pk.length === 0) throw badRequest('This table has no primary key, so rows cannot be changed here')
  const keys = Object.keys(pk)
  if (keys.length !== meta.pk.length || !meta.pk.every((k) => keys.includes(k))) throw badRequest('Give the full primary key')
  return meta.pk
    .map((k) => {
      const c = column(meta, k)
      params.push(coerce(pk[k], c.type, c.name))
      return `${quoteIdent(k)} = ?`
    })
    .join(' AND ')
}

export function buildSelectOne(table: string, pk: Record<string, unknown>, meta: TableMeta): Built {
  const params: unknown[] = []
  return { text: `SELECT * FROM ${quoteIdent(table)} WHERE ${pkWhere(pk, meta, params)} LIMIT 1`, params }
}

export function buildUpdate(table: string, pk: Record<string, unknown>, set: Record<string, unknown>, meta: TableMeta): Built {
  const names = Object.keys(set)
  if (names.length === 0) throw badRequest('Nothing to change')
  const params: unknown[] = []
  const sets = names.map((n) => {
    const c = column(meta, n)
    params.push(coerce(set[n], c.type, c.name))
    return `${quoteIdent(n)} = ?`
  })
  return { text: `UPDATE ${quoteIdent(table)} SET ${sets.join(', ')} WHERE ${pkWhere(pk, meta, params)}`, params }
}

export function buildDelete(table: string, pks: Record<string, unknown>[], meta: TableMeta): Built {
  if (pks.length === 0) throw badRequest('Nothing to delete')
  if (pks.length > MAX_DELETE) throw badRequest(`Delete at most ${MAX_DELETE} rows at once`)
  const params: unknown[] = []
  const clauses = pks.map((pk) => `(${pkWhere(pk, meta, params)})`)
  return { text: `DELETE FROM ${quoteIdent(table)} WHERE ${clauses.join(' OR ')}`, params }
}

/** The key of a row just inserted, or null when it cannot be known (a generated key we were not told). */
export function insertedKey(values: Record<string, unknown>, meta: TableMeta, insertId: number | string): Record<string, unknown> | null {
  if (meta.pk.length === 0) return null
  const out: Record<string, unknown> = {}
  for (const k of meta.pk) {
    const given = values[k]
    if (given !== undefined && given !== null) out[k] = given
    else if (meta.columns.find((c) => c.name === k)?.auto && Number(insertId) > 0) out[k] = insertId
    else return null
  }
  return out
}
