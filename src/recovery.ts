/**
 * Recovery mode: a database that was stopped for being full is started again for a short while so
 * its owner can remove data. Reading and removing are allowed; anything that adds is refused.
 */
import { actionSchema } from './designer.js'
import { classify, splitStatements } from './classify.js'
import { badRequest } from './errors.js'

const SAFE_OPS = new Set(['health', 'schema', 'stats', 'rows', 'query', 'delete', 'execute', 'ddl', 'bootstrap', 'lock', 'unlock', 'vacuum'])
const REMOVES = new Set(['delete', 'truncate', 'drop'])
const READS = new Set(['select', 'show', 'values', 'table', 'explain', 'with', 'set', 'reset'])
const REMOVING_ACTIONS = new Set(['dropTable', 'truncate', 'dropColumn', 'dropIndex', 'dropConstraint'])

const refuse = () => badRequest('This database is in recovery mode: you can read it and remove data, but not add or change anything.')

/** Throws unless the request only reads or removes. */
export function assertRecoveryAllowed(op: string, input: unknown): void {
  if (!SAFE_OPS.has(op)) throw refuse()

  if (op === 'execute') {
    const statements = (input as { statements?: unknown })?.statements
    if (!Array.isArray(statements)) throw refuse()
    for (const text of statements) {
      for (const piece of splitStatements(String(text))) {
        const c = classify(piece)
        // A read that hides a change (a WITH that deletes, EXPLAIN ANALYZE of an insert) is not a read.
        if (!REMOVES.has(c.verb) && !(READS.has(c.verb) && !c.writes)) throw refuse()
      }
    }
  }

  if (op === 'ddl') {
    const parsed = actionSchema.safeParse((input as { action?: unknown })?.action)
    if (!parsed.success || !REMOVING_ACTIONS.has(parsed.data.action)) throw refuse()
  }
}
