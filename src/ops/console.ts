/**
 * The SQL console. A script runs in one transaction on the app role: the first error rolls
 * everything back and names the statement that failed. `query` is read-only; `execute` may write.
 */
import { z } from 'zod'
import { classify, splitStatements, type Classified } from '../classify.js'
import { withTx, type Tx } from '../db.js'
import { badRequest } from '../errors.js'
import type { Op } from './types.js'

const MAX_ROWS = 1000

const input = z.object({
  statements: z.array(z.string().min(1).max(100_000)).min(1).max(20),
  explain: z.enum(['plan', 'analyze']).optional(),
  maxRows: z.number().int().min(1).max(MAX_ROWS).default(MAX_ROWS),
})

/** Postgres type ids the grid understands, as the names it already knows how to show. */
const TYPE_NAMES: Record<number, string> = {
  16: 'boolean', 17: 'bytea', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 114: 'json', 700: 'real', 701: 'double precision',
  1043: 'character varying', 1082: 'date', 1083: 'time without time zone', 1114: 'timestamp without time zone',
  1184: 'timestamp with time zone', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
  1007: 'integer[]', 1009: 'text[]', 1016: 'bigint[]',
}

const cell = (v: unknown) => (Buffer.isBuffer(v) ? { $bytea: v.length } : typeof v === 'bigint' ? v.toString() : v)

export interface StatementResult {
  command: string
  rowCount: number
  columns: { name: string; type: string }[]
  rows: unknown[][]
  truncated: boolean
  ms: number
}

/** A SELECT can be read through a cursor, so a huge table never has to fit in memory. */
const cursorable = (c: Classified) => c.verb === 'select' || c.verb === 'values' || c.verb === 'table' || (c.verb === 'with' && !c.writes)

async function runOne(tx: Tx, c: Classified, index: number, maxRows: number): Promise<StatementResult> {
  const started = Date.now()
  const done = (command: string, rows: unknown[][], columns: StatementResult['columns'], rowCount: number, truncated = false): StatementResult => ({
    command, rowCount, columns, rows, truncated, ms: Date.now() - started,
  })

  if (cursorable(c)) {
    const name = `console_${index}`
    const declare = `DECLARE ${name} NO SCROLL CURSOR FOR `
    try {
      await tx.unsafe(declare + c.sql)
    } catch (e) {
      // Postgres counts from the start of what it received; the person typed only the part after the prefix.
      const err = e as { position?: string }
      if (err.position) err.position = String(Math.max(1, Number(err.position) - declare.length))
      throw e
    }
    const page = await tx.unsafe(`FETCH FORWARD ${maxRows + 1} FROM ${name}`).values()
    const columns = ((page as unknown as { columns?: { name: string; type: number }[] }).columns ?? []).map((col) => ({ name: col.name, type: TYPE_NAMES[col.type] ?? 'text' }))
    const truncated = page.length > maxRows
    const rows = page.slice(0, maxRows).map((r) => (r as unknown[]).map(cell))
    await tx.unsafe(`CLOSE ${name}`)
    return done('SELECT', rows, columns, rows.length, truncated)
  }

  const result = await tx.unsafe(c.sql).values()
  const columns = ((result as unknown as { columns?: { name: string; type: number }[] }).columns ?? []).map((col) => ({ name: col.name, type: TYPE_NAMES[col.type] ?? 'text' }))
  const truncated = result.length > maxRows
  const rows = result.slice(0, maxRows).map((r) => (r as unknown[]).map(cell))
  const command = (result as unknown as { command?: string }).command ?? c.verb.toUpperCase()
  return done(command, rows, columns, columns.length ? rows.length : result.count ?? 0, truncated)
}

function prepare(statements: string[], explain: 'plan' | 'analyze' | undefined): Classified[] {
  const parsed = statements.flatMap((s) => splitStatements(s)).map((p) => classify(p))
  if (parsed.length === 0) throw badRequest('There is nothing to run')
  if (parsed.length > 20) throw badRequest('Run at most 20 statements at a time')
  const refused = parsed.find((c) => c.refused)
  if (refused) throw badRequest(refused.refused!)
  if (explain) {
    if (parsed.length !== 1) throw badRequest('Explain works on one statement at a time')
    if (parsed[0]!.verb === 'explain') throw badRequest('Write the statement itself; the console adds EXPLAIN')
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

      // Explaining runs the statement only when asked to analyse, and always without write rights.
      const effective = req.explain ? 'read' : mode
      return withTx(claims, address, effective, async (tx) => {
        const results: StatementResult[] = []
        for (let i = 0; i < statements.length; i++) {
          const c = statements[i]!
          try {
            if (req.explain) {
              const prefix = req.explain === 'analyze' ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' : 'EXPLAIN (FORMAT TEXT) '
              try {
                results.push(await runOne(tx, { ...c, sql: prefix + c.sql, verb: 'explain', writes: false, returnsRows: true }, i, req.maxRows))
              } catch (e) {
                const err = e as { position?: string }
                if (err.position) err.position = String(Math.max(1, Number(err.position) - prefix.length))
                throw e
              }
            } else {
              results.push(await runOne(tx, c, i, req.maxRows))
            }
          } catch (e) {
            if (e && typeof e === 'object') (e as { statementIndex?: number }).statementIndex = i
            throw e
          }
        }
        return { results }
      })
    },
  }
}

export const query: Op = make('read')
export const execute: Op = make('write')
