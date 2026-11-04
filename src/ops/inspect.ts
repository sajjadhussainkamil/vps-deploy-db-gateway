/** Read-only inspection: health, the schema tree, and the numbers the storage ladder needs. */
import { z } from 'zod'
import { withConn, withTx } from '../db.js'
import { assertUserSchema } from '../sqlbuild.js'
import type { Op } from './types.js'

export const health: Op = {
  mode: 'read',
  input: z.object({}).default({}),
  async run({ claims, address }) {
    return withTx(claims, address, 'read', async (tx) => {
      const [r] = await tx<{ version: string; up: number; conns: number; ro: string }[]>`
        SELECT version(),
               extract(epoch FROM now() - pg_postmaster_start_time())::int AS up,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns,
               current_setting('default_transaction_read_only') AS ro`
      return { version: r!.version, uptimeS: r!.up, connections: r!.conns, readOnly: r!.ro === 'on' }
    })
  },
}

interface TableRow {
  schema: string
  name: string
  kind: string
  estRows: string
  bytes: string
}

export const schema: Op = {
  mode: 'read',
  input: z.object({ schemas: z.array(z.string().min(1).max(63)).max(20).optional() }).default({}),
  async run({ claims, address, input }) {
    const wanted = (input as { schemas?: string[] }).schemas
    wanted?.forEach(assertUserSchema)

    return withTx(claims, address, 'read', async (tx) => {
      const names = wanted ?? null
      const tables = await tx<TableRow[]>`
        SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
               greatest(c.reltuples, 0)::bigint::text AS "estRows",
               pg_total_relation_size(c.oid)::text AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm')
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
           AND (${names}::text[] IS NULL OR n.nspname = ANY(${names}::text[]))
         ORDER BY n.nspname, c.relname`

      const columns = await tx<{ schema: string; table: string; name: string; type: string; notNull: boolean; default: string | null }[]>`
        SELECT n.nspname AS schema, c.relname AS "table", a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
               pg_get_expr(d.adbin, d.adrelid) AS "default"
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
           AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
           AND (${names}::text[] IS NULL OR n.nspname = ANY(${names}::text[]))
         ORDER BY n.nspname, c.relname, a.attnum`

      const keys = await tx<{ schema: string; table: string; column: string; kind: string; refSchema: string | null; refTable: string | null; refColumn: string | null }[]>`
        SELECT n.nspname AS schema, c.relname AS "table", a.attname AS "column", k.contype AS kind,
               rn.nspname AS "refSchema", rc.relname AS "refTable", ra.attname AS "refColumn"
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.attnum
          LEFT JOIN pg_class rc ON rc.oid = k.confrelid
          LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          LEFT JOIN LATERAL (SELECT k.confkey[u.ord::int] AS attnum) rk ON k.contype = 'f'
          LEFT JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = rk.attnum
         WHERE k.contype IN ('p', 'f') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
           AND (${names}::text[] IS NULL OR n.nspname = ANY(${names}::text[]))`

      const indexes = await tx<{ schema: string; table: string; name: string; unique: boolean; def: string }[]>`
        SELECT n.nspname AS schema, t.relname AS "table", i.relname AS name,
               x.indisunique AS "unique", pg_get_indexdef(i.oid) AS def
          FROM pg_index x
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
           AND (${names}::text[] IS NULL OR n.nspname = ANY(${names}::text[]))`

      const bySchema = new Map<string, unknown[]>()
      for (const t of tables) {
        const id = (r: { schema: string; table: string }) => r.schema === t.schema && r.table === t.name
        const pk = new Set(keys.filter((k) => id(k) && k.kind === 'p').map((k) => k.column))
        const fks = new Map(keys.filter((k) => id(k) && k.kind === 'f').map((k) => [k.column, { schema: k.refSchema, table: k.refTable, column: k.refColumn }]))
        const entry = {
          name: t.name,
          kind: t.kind === 'v' ? 'view' : t.kind === 'm' ? 'materialized' : 'table',
          estRows: Number(t.estRows),
          bytes: Number(t.bytes),
          columns: columns.filter(id).map((c) => ({ name: c.name, type: c.type, notNull: c.notNull, default: c.default, isPk: pk.has(c.name), fk: fks.get(c.name) ?? null })),
          indexes: indexes.filter(id).map((i) => ({ name: i.name, unique: i.unique, definition: i.def })),
        }
        bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), entry])
      }
      return { schemas: [...bySchema].map(([name, list]) => ({ name, tables: list })) }
    })
  },
}

/** Everything the sweep and the Overview page need, in one call. */
export const stats: Op = {
  mode: 'read',
  input: z.object({}).default({}),
  async run({ claims, address }) {
    const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
    return withConn(claims, address, async (sql) => {
      const [size] = await sql<{ data: string }[]>`SELECT pg_database_size(current_database())::text AS data`
      // WAL and temp listing need elevated rights and a directory that exists; a miss is reported as unknown, not zero.
      const wal = await sql<{ n: string }[]>`SELECT coalesce(sum(size), 0)::text AS n FROM pg_ls_waldir()`.catch(() => null)
      const temp = await sql<{ n: string }[]>`SELECT coalesce(sum(size), 0)::text AS n FROM pg_ls_tmpdir()`.catch(() => null)
      const [act] = await sql<{ conns: number }[]>`SELECT count(*)::int AS conns FROM pg_stat_activity WHERE datname = current_database()`
      const [cache] = await sql<{ hit: string | null }[]>`
        SELECT round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2)::text AS hit
          FROM pg_stat_database WHERE datname = current_database()`
      const [lock] = await sql<{ locked: boolean }[]>`
        SELECT coalesce((SELECT bool_or(s ~ 'default_transaction_read_only=on')
                           FROM pg_db_role_setting r, unnest(r.setconfig) s
                          WHERE r.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())), false) AS locked`

      // What a brand-new application session would see. An override on the role defeats the database lock.
      let writableSession: boolean | null = null
      if (claims.probe) {
        writableSession = await withConn(claims, address, async (s) => {
          const [r] = await s<{ ro: string }[]>`SELECT current_setting('default_transaction_read_only') AS ro`
          return r!.ro !== 'on'
        }, claims.probe).catch(() => null)
      }

      return {
        dataBytes: num(size!.data),
        walBytes: wal ? num(wal[0]?.n) : null,
        tempBytes: temp ? num(temp[0]?.n) : null,
        connections: act!.conns,
        cacheHit: cache?.hit ? Number(cache.hit) : null,
        locked: lock?.locked ?? false,
        writableSession,
      }
    })
  },
}
