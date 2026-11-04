/** One short-lived connection per request, inside a transaction with hard timeouts. */
import postgres from 'postgres'
import type { Claims } from './token.js'
import type { ColumnMeta, TableMeta } from './sqlbuild.js'
import { assertUserSchema } from './sqlbuild.js'
import { notFound } from './errors.js'

export type Tx = postgres.TransactionSql
export type Sql = postgres.Sql

function open(claims: Claims, address: string, user?: { user: string; password: string }): Sql {
  const t = claims.target
  return postgres({
    // The address was resolved and checked already; connecting to it, not the name, closes the DNS gap.
    host: address,
    port: t.port,
    database: t.db,
    username: user?.user ?? t.user,
    password: user?.password ?? t.password,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 2,
    ssl: false,
    onnotice: () => {},
    connection: { application_name: 'platform-gateway' },
  })
}

/**
 * Run `fn` in a transaction. Reads are READ ONLY. Writes use a plain BEGIN so they obey the
 * database's own read-only lock; an explicit READ WRITE would override it and defeat the lock.
 * The one exception is recovery mode, where the owner is let through the lock to remove data
 * (recovery.ts has already limited what the request may do).
 */
export async function withTx<T>(claims: Claims, address: string, mode: 'read' | 'write', fn: (tx: Tx) => Promise<T>): Promise<T> {
  const sql = open(claims, address)
  try {
    const run = async (tx: Tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.trunc(claims.limits.timeoutMs)}`)
      await tx.unsafe(`SET LOCAL lock_timeout = 5000`)
      return fn(tx)
    }
    const begin = mode === 'read' ? sql.begin('read only', run) : claims.recoveryOnly ? sql.begin('read write', run) : sql.begin(run)
    return (await begin) as T
  } finally {
    await sql.end({ timeout: 2 })
  }
}

/** A connection with no transaction, for the few statements Postgres refuses inside one (VACUUM). */
export async function withConn<T>(claims: Claims, address: string, fn: (sql: Sql) => Promise<T>, as?: { user: string; password: string }): Promise<T> {
  const sql = open(claims, address, as)
  try {
    await sql.unsafe(`SET statement_timeout = ${Math.trunc(claims.limits.timeoutMs)}`)
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 2 })
  }
}

/** The table's real columns and primary key. Everything caller-named is checked against this. */
export async function tableMeta(tx: Tx, schema: string, table: string): Promise<TableMeta> {
  assertUserSchema(schema)
  const columns = await tx<ColumnMeta[]>`
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS "notNull", a.atthasdef AS "hasDefault"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table}
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`
  if (columns.length === 0) throw notFound(`There is no table "${table}"`)
  const pk = await tx<{ name: string }[]>`
    SELECT a.attname AS name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE i.indisprimary AND n.nspname = ${schema} AND c.relname = ${table}
     ORDER BY array_position(i.indkey::int2[], a.attnum)`
  return { columns: [...columns], pk: pk.map((r) => r.name) }
}

/** Rows as JSON-safe values: binary becomes a size marker, everything else passes through. */
export function wire(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      out[k] = Buffer.isBuffer(v) ? { $bytea: v.length } : typeof v === 'bigint' ? v.toString() : v
    }
    return out
  })
}
