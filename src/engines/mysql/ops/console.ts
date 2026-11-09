/**
 * The SQL console for MySQL. Data changes roll back on the first error, but structure changes save
 * themselves, which the console tells the person before it runs.
 */
import { z } from 'zod'
import { badRequest } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { classify, splitStatements, type Classified } from '../classify.js'
import { cell, driver, withConn, type Conn } from '../conn.js'

const MAX_ROWS = 1000

const input = z.object({
  statements: z.array(z.string().min(1).max(100_000)).min(1).max(20),
  explain: z.enum(['plan', 'analyze']).optional(),
  maxRows: z.number().int().min(1).max(MAX_ROWS).default(MAX_ROWS),
})

/** MySQL's wire type ids, as the names the grid already knows how to show. */
const TYPE_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year',
  15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 252: 'text', 253: 'varchar', 254: 'char',
}
const BINARY_CHARSET = 63

interface Field {
  name: string
  columnType?: number
  type?: number
  characterSet?: number
}

export interface StatementResult {
  command: string
  rowCount: number
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
  ms: number
}

const typeName = (f: Field) => {
  const id = f.columnType ?? f.type ?? -1
  if ((id === 252 || id === 253 || id === 254) && f.characterSet === BINARY_CHARSET) return 'blob'
  return TYPE_NAMES[id] ?? 'text'
}

/** Streams so a huge result stops being kept after maxRows; the rest is read and thrown away. */
function runOne(c: Conn, sql: string, command: string, maxRows: number): Promise<StatementResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const rows: unknown[][] = []
    let columns: StatementResult['columns'] | null = null
    let affected: number | null = null
    let truncated = false
    const q = driver(c).query({ sql, rowsAsArray: true })
    q.on('error', reject)
    q.on('fields', (fields: Field[]) => {
      // A stored procedure can answer with several results; the first with columns is shown.
      if (!columns) columns = fields.map((f) => ({ name: f.name, type: typeName(f) }))
    })
    q.on('result', (row: unknown) => {
      if (Array.isArray(row)) {
        if (rows.length < maxRows) rows.push(row.map(cell))
        else truncated = true
      } else if (row && typeof row === 'object' && affected === null) {
        affected = Number((row as { affectedRows?: number }).affectedRows ?? 0)
      }
    })
    q.on('end', () => resolve({ command, rowCount: columns ? rows.length : affected ?? 0, columns: columns ?? [], rows, truncated, ms: Date.now() - started }))
  })
}

function prepare(statements: string[], explain: 'plan' | 'analyze' | undefined): Classified[] {
  const parsed = statements.flatMap((s) => splitStatements(s)).map(classify)
  if (parsed.length === 0) throw badRequest('There is nothing to run')
  if (parsed.length > 20) throw badRequest('Run at most 20 statements at a time')
  const refused = parsed.find((c) => c.refused)
  if (refused) throw badRequest(refused.refused!)
  if (explain) {
    if (parsed.length !== 1) throw badRequest('Explain works on one statement at a time')
    if (parsed[0]!.verb === 'explain') throw badRequest('Write the statement itself; the console adds EXPLAIN')
    if (explain === 'analyze' && !['select', 'with', 'table'].includes(parsed[0]!.verb)) throw badRequest('MySQL can only analyse a SELECT')
  }
  return parsed
}

function make(mode: 'read' | 'write'): Op {
  return {
    mode,
    input,
    async run({ claims, address, input: raw }) {
      const req = input.parse(raw)
      const statements = prepare(req.statements, req.explain)
      const effective = req.explain ? 'read' : mode
      if (effective === 'read' && statements.some((s) => s.writes)) throw badRequest('This script changes data. Switch on "Allow writes" to run it.')

      return withConn(claims, address, async (c) => {
        await c.query(`SET SESSION max_execution_time = ${Math.trunc(claims.limits.timeoutMs)}, sql_select_limit = ${req.maxRows + 1}`)
        // Off rather than one transaction: statements after a structure change must still roll back together.
        if (effective === 'write') await c.query('SET SESSION autocommit = 0')
        else await c.query('START TRANSACTION READ ONLY')
        try {
          const results: StatementResult[] = []
          for (let i = 0; i < statements.length; i++) {
            const s = statements[i]!
            try {
              const prefix = req.explain === 'analyze' ? 'EXPLAIN ANALYZE ' : req.explain === 'plan' ? 'EXPLAIN FORMAT=TREE ' : ''
              results.push(await runOne(c, prefix + s.sql, prefix ? 'EXPLAIN' : s.verb.toUpperCase(), req.maxRows))
            } catch (e) {
              if (e && typeof e === 'object') (e as { statementIndex?: number }).statementIndex = i
              throw e
            }
          }
          await c.query('COMMIT')
          return { results }
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined)
          throw e
        }
      })
    },
  }
}

export const query: Op = make('read')
export const execute: Op = make('write')
