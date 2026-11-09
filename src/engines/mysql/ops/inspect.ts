/** Read-only inspection of a MySQL database: health, the table tree, and the numbers the ladder needs. */
import { z } from 'zod'
import type { Op } from '../../../ops/types.js'
import { databaseOf, withConn, withTx, type Conn, type Rows } from '../conn.js'
import { quoteIdent } from '../sqlbuild.js'

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

const status = async (c: Conn, name: string) => {
  const [rows] = await c.query<Rows>(`SHOW GLOBAL STATUS LIKE '${name}'`)
  return num(rows[0]?.Value)
}

export const health: Op = {
  mode: 'read',
  input: z.object({}).default({}),
  async run({ claims, address }) {
    return withTx(claims, address, 'read', async (c) => {
      const [rows] = await c.query<Rows>('SELECT VERSION() AS version, @@global.read_only AS ro')
      return { version: `MySQL ${rows[0]!.version}`, uptimeS: await status(c, 'Uptime'), connections: await status(c, 'Threads_connected'), readOnly: num(rows[0]!.ro) === 1 }
    })
  },
}

/** A column default as SQL, for restating a column; expressions come back from the catalog bare. */
export function defaultAsSql(dflt: unknown, extra: string): string | null {
  if (dflt === null || dflt === undefined) return null
  const text = String(dflt)
  if (/DEFAULT_GENERATED/i.test(extra)) return /^current_timestamp/i.test(text) ? text : `(${text})`
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export const schema: Op = {
  mode: 'read',
  input: z.object({ schemas: z.array(z.string().min(1).max(64)).max(20).optional() }).default({}),
  async run({ claims, address }) {
    const db = databaseOf(claims)
    return withTx(claims, address, 'read', async (c) => {
      const [tables] = await c.execute<Rows>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS estRows, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [db]
      )
      const [columns] = await c.execute<Rows>(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra, COLUMN_KEY AS ckey, COLLATION_NAME AS collation
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db]
      )
      const [fks] = await c.execute<Rows>(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
           FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [db]
      )
      const [stats] = await c.execute<Rows>(
        `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, SUB_PART AS sub
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [db]
      )

      const list = tables.map((t) => {
        const indexes = new Map<string, { unique: boolean; parts: string[] }>()
        for (const s of stats.filter((x) => x.tbl === t.name)) {
          const entry = indexes.get(String(s.name)) ?? { unique: num(s.nonUnique) === 0, parts: [] }
          entry.parts.push(`${quoteIdent(String(s.col))}${s.sub ? `(${s.sub})` : ''}`)
          indexes.set(String(s.name), entry)
        }
        return {
          name: t.name,
          kind: t.kind === 'VIEW' ? 'view' : 'table',
          estRows: num(t.estRows),
          bytes: num(t.bytes),
          columns: columns
            .filter((x) => x.tbl === t.name)
            .map((x) => {
              const fk = fks.find((f) => f.tbl === t.name && f.col === x.name)
              return {
                name: x.name,
                type: x.type,
                notNull: x.nullable === 'NO',
                default: x.dflt ?? null,
                isPk: x.ckey === 'PRI',
                fk: fk ? { schema: db, table: fk.refTable, column: fk.refColumn } : null,
                current: { type: String(x.type), nullable: x.nullable !== 'NO', defaultSql: defaultAsSql(x.dflt, String(x.extra)), extra: String(x.extra), collation: x.collation ?? null },
              }
            }),
          indexes: [...indexes].map(([name, ix]) => ({ name, unique: ix.unique, definition: `${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(name)} (${ix.parts.join(', ')})` })),
        }
      })
      return { schemas: [{ name: db, tables: list }] }
    })
  },
}

const statsInput = z.object({ analyze: z.boolean().default(false) }).default({})

/** Everything the sweep and the Overview page need, in one call. Runs as root for the file sizes. */
export const stats: Op = {
  mode: 'read',
  input: statsInput,
  async run({ claims, address, input }) {
    const db = databaseOf(claims)
    const { analyze } = statsInput.parse(input)
    return withConn(claims, address, async (c) => {
      // InnoDB's sizes are sampled, so near the line the biggest tables are measured afresh.
      if (analyze) {
        const [big] = await c.execute<Rows>(
          `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 5`,
          [db]
        )
        for (const t of big) await c.query(`ANALYZE TABLE ${quoteIdent(db)}.${quoteIdent(String(t.name))}`).catch(() => undefined)
      }
      const [sizes] = await c.execute<Rows>(
        `SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS data, COALESCE(SUM(DATA_FREE), 0) AS free
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
        [db]
      )
      const [allocated] = await c.execute<Rows>(
        `SELECT COALESCE(SUM(ALLOCATED_SIZE), 0) AS n FROM information_schema.INNODB_TABLESPACES WHERE LEFT(NAME, CHAR_LENGTH(?) + 1) = CONCAT(?, '/')`,
        [db, db]
      )
      const undo = await c.query<Rows>(`SELECT COALESCE(SUM(ALLOCATED_SIZE), 0) AS n FROM information_schema.INNODB_TABLESPACES WHERE SPACE_TYPE = 'Undo'`).catch(() => null)
      const temp = await c.query<Rows>('SELECT COALESCE(SUM(SIZE), 0) AS n FROM information_schema.INNODB_SESSION_TEMP_TABLESPACES').catch(() => null)
      const reads = await status(c, 'Innodb_buffer_pool_reads')
      const requests = await status(c, 'Innodb_buffer_pool_read_requests')
      const [ro] = await c.query<Rows>('SELECT @@global.read_only AS ro')
      const locked = num(ro[0]?.ro) === 1

      return {
        dataBytes: num(sizes[0]?.data),
        walBytes: undo ? num(undo[0][0]?.n) : null,
        tempBytes: temp ? num(temp[0][0]?.n) : null,
        connections: await status(c, 'Threads_connected'),
        cacheHit: requests > 0 ? Math.round(10_000 * (1 - reads / requests)) / 100 : null,
        locked,
        // The lock is server-wide, so a new application session sees exactly this.
        writableSession: !locked,
        allocatedBytes: num(allocated[0]?.n),
        reclaimableBytes: num(sizes[0]?.free),
      }
    })
  },
}
