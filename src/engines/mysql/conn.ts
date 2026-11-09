/** One short-lived MySQL connection per request, with hard time limits. */
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import { GatewayError, notFound } from '../../errors.js'
import type { Claims } from '../../token.js'
import type { ColumnMeta, TableMeta } from './sqlbuild.js'

export type Conn = Connection
/** The driver's own connection underneath: its query events and its socket. */
export const driver = (c: Conn) => (c as unknown as { connection: { query(o: { sql: string; rowsAsArray: boolean }): NodeJS.EventEmitter; stream: { destroyed: boolean } } }).connection
export type Rows = RowDataPacket[]
export type Header = ResultSetHeader

export interface Login {
  user: string
  password: string
}

/** The database the token names is the only one a request can touch; `public` is the shared UI default. */
export function databaseOf(claims: Claims, schema?: string): string {
  const db = claims.target.db
  if (schema !== undefined && schema !== 'public' && schema !== db) throw new GatewayError(400, 'bad_request', 'That schema is not available')
  return db
}

export async function open(claims: Claims, address: string, as?: Login, charset = 'utf8mb4'): Promise<Conn> {
  const t = claims.target
  const c = await mysql.createConnection({
    // The address was resolved and checked already; connecting to it, not the name, closes the DNS gap.
    host: address,
    port: t.port,
    user: as?.user ?? t.user,
    password: as?.password ?? t.password,
    database: t.db,
    connectTimeout: 5_000,
    multipleStatements: false,
    flags: ['-LOCAL_FILES'],
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: 'Z',
    charset,
  })
  await c.query("SET SESSION time_zone = '+00:00', information_schema_stats_expiry = 0, lock_wait_timeout = 5, innodb_lock_wait_timeout = 5")
  return c
}

/** Ends whatever `c` is running when the time is up; max_execution_time only covers plain reads. */
function watchdog(claims: Claims, address: string, c: Conn, as?: Login): () => void {
  const timer = setTimeout(() => {
    void (async () => {
      const killer = await open(claims, address, as)
      try {
        await killer.query(`KILL QUERY ${Math.trunc(c.threadId)}`)
      } finally {
        killer.destroy()
      }
    })().catch(() => c.destroy())
  }, Math.trunc(claims.limits.timeoutMs) + 500)
  timer.unref()
  return () => clearTimeout(timer)
}

const close = (c: Conn) => c.end().catch(() => c.destroy())

export async function withConn<T>(claims: Claims, address: string, fn: (c: Conn) => Promise<T>, as?: Login): Promise<T> {
  const c = await open(claims, address, as)
  const stop = watchdog(claims, address, c, as)
  try {
    return await fn(c)
  } finally {
    stop()
    await close(c)
  }
}

export async function withTx<T>(claims: Claims, address: string, mode: 'read' | 'write', fn: (c: Conn) => Promise<T>): Promise<T> {
  return withConn(claims, address, async (c) => {
    if (mode === 'read') await c.query(`SET SESSION max_execution_time = ${Math.trunc(claims.limits.timeoutMs)}`)
    await c.query(mode === 'read' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION')
    try {
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw e
    }
  })
}

/** The table's real columns and primary key. Everything caller-named is checked against this. */
export async function tableMeta(c: Conn, db: string, table: string): Promise<TableMeta> {
  const [columns] = await c.execute<Rows>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, table]
  )
  if (columns.length === 0) throw notFound(`There is no table "${table}"`)
  const [pk] = await c.execute<Rows>(
    `SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`,
    [db, table]
  )
  const list: ColumnMeta[] = columns.map((r) => ({
    name: String(r.name),
    type: String(r.type),
    notNull: r.nullable === 'NO',
    hasDefault: r.dflt !== null || /auto_increment|DEFAULT_GENERATED/i.test(String(r.extra)),
    auto: /auto_increment/i.test(String(r.extra)),
  }))
  return { columns: list, pk: pk.map((r) => String(r.name)) }
}

export const cell = (v: unknown) => (Buffer.isBuffer(v) ? { $bytea: v.length } : typeof v === 'bigint' ? v.toString() : v)

/** Rows as JSON-safe values: binary becomes a size marker, everything else passes through. */
export function wire(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])))
}
