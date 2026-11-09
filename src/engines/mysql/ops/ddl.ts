/** Changing a MySQL table's structure. The whole change is one statement wherever MySQL allows it. */
import { z } from 'zod'
import { badRequest } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { databaseOf, withConn, type Conn, type Rows } from '../conn.js'
import { actionSchema, buildStatements, DesignError, type CurrentColumn, type DesignAction } from '../designer.js'
import { defaultAsSql } from './inspect.js'

const input = z.object({ action: actionSchema })

async function columnsOf(c: Conn, db: string, table: string) {
  const [rows] = await c.execute<Rows>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra, COLLATION_NAME AS collation, DATA_TYPE AS base
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table]
  )
  return rows
}

/** The real column always replaces what the browser said about it. */
async function withCatalog(c: Conn, db: string, action: DesignAction): Promise<{ action: DesignAction; columnTypes?: Map<string, string> }> {
  if (action.action === 'addIndex') {
    const rows = await columnsOf(c, db, action.table)
    return { action, columnTypes: new Map(rows.map((r) => [String(r.name), String(r.base).toLowerCase()])) }
  }
  if (action.action !== 'alterColumn') return { action }
  const found = (await columnsOf(c, db, action.table)).find((r) => r.name === action.column)
  if (!found) throw badRequest(`There is no column "${action.column}" in this table`)
  if (/GENERATED/i.test(String(found.extra).replace(/DEFAULT_GENERATED/i, ''))) throw badRequest('A generated column cannot be changed here')
  const current: CurrentColumn = {
    type: String(found.type),
    nullable: found.nullable !== 'NO',
    defaultSql: defaultAsSql(found.dflt, String(found.extra)),
    extra: String(found.extra),
    collation: found.collation ? String(found.collation) : null,
  }
  return { action: { ...action, current } }
}

export const ddl: Op = {
  mode: 'write',
  input,
  async run({ claims, address, input: raw }) {
    const parsed = input.parse(raw)
    const db = databaseOf(claims, parsed.action.action === 'createTable' ? parsed.action.table.schema : parsed.action.schema)
    return withConn(claims, address, async (c) => {
      let statements: string[]
      try {
        const ready = await withCatalog(c, db, parsed.action)
        statements = buildStatements(ready.action, { columnTypes: ready.columnTypes })
      } catch (e) {
        if (e instanceof DesignError) throw badRequest(e.message)
        throw e
      }
      for (let i = 0; i < statements.length; i++) {
        try {
          await c.query(statements[i]!)
        } catch (e) {
          if (e && typeof e === 'object') (e as { statementIndex?: number }).statementIndex = i
          throw e
        }
      }
      return { sql: statements }
    })
  },
}
