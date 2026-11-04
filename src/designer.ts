/**
 * Builds table-structure SQL from typed requests. Nothing here accepts SQL text: names are
 * quoted, types come from a short grammar, and defaults are a fixed list or a quoted literal.
 * The same file runs in the gateway (to execute) and the portal (to preview); a test keeps them equal.
 */
import { z } from 'zod'

export class DesignError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
const qualified = (schema: string, name: string) => `${quote(schema)}.${quote(name)}`

/** Names given to new things. Existing things keep whatever name they already have. */
const newName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'Use lowercase letters, numbers and underscores, starting with a letter')
const oldName = z.string().min(1).max(63)

const ALIASES: Record<string, string> = {
  int2: 'smallint', int4: 'integer', int: 'integer', int8: 'bigint', bool: 'boolean', float4: 'real', float8: 'double precision',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp', 'time with time zone': 'timetz', 'time without time zone': 'time',
}
const PLAIN = new Set([
  'text', 'uuid', 'citext', 'boolean', 'smallint', 'integer', 'bigint', 'real', 'double precision', 'date', 'time', 'timetz', 'timestamp',
  'timestamptz', 'interval', 'jsonb', 'json', 'bytea', 'smallserial', 'serial', 'bigserial',
])

/** The type as Postgres should receive it, or null when it is not one of the offered kinds. */
export function normalizeType(raw: string): string | null {
  let t = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  let dims = ''
  while (t.endsWith('[]')) {
    dims += '[]'
    t = t.slice(0, -2).trim()
  }
  if (dims.length > 6) return null
  t = ALIASES[t] ?? t

  const out = (base: string) => (dims && /serial$/.test(base) ? null : base + dims)
  if (PLAIN.has(t)) return out(t)

  let m = /^(varchar|character varying|char|character)\((\d{1,8})\)$/.exec(t)
  if (m) {
    const n = Number(m[2])
    return n >= 1 && n <= 10_485_760 ? out(`${m[1]!.startsWith('char') && m[1] !== 'character varying' ? 'char' : 'varchar'}(${n})`) : null
  }
  m = /^(?:numeric|decimal)(?:\((\d{1,4})(?:, ?(\d{1,4}))?\))?$/.exec(t)
  if (m) {
    if (!m[1]) return out('numeric')
    const p = Number(m[1])
    const s = m[2] ? Number(m[2]) : 0
    return p >= 1 && p <= 1000 && s <= p ? out(`numeric(${p}${m[2] ? `,${s}` : ''})`) : null
  }
  m = /^vector\((\d{1,5})\)$/.exec(t)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 16_000 ? out(`vector(${m[1]})`) : null
  return null
}

const typeField = z.string().transform((v, ctx) => {
  const t = normalizeType(v)
  if (!t) ctx.addIssue({ code: 'custom', message: `"${v}" is not a type you can pick here` })
  return t ?? ''
})

const EXPRESSIONS = ['now()', 'gen_random_uuid()', 'current_date', 'current_timestamp', 'true', 'false'] as const

export const defaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expr'), value: z.enum(EXPRESSIONS) }),
  z.object({ kind: z.literal('literal'), value: z.string().max(1000).refine((v) => !v.includes('\0'), 'Not a valid default') }),
])
export type DefaultSpec = z.infer<typeof defaultSchema>

export const columnSchema = z.object({
  name: newName,
  type: typeField,
  nullable: z.boolean().default(true),
  default: defaultSchema.nullable().default(null),
  unique: z.boolean().default(false),
  identity: z.enum(['always', 'by_default']).nullable().default(null),
})
export type ColumnDef = z.infer<typeof columnSchema>

const REFERENTIAL = ['no action', 'restrict', 'cascade', 'set null', 'set default'] as const

export const foreignKeySchema = z.object({
  name: newName.optional(),
  columns: z.array(oldName).min(1).max(8),
  refSchema: oldName.default('public'),
  refTable: oldName,
  refColumns: z.array(oldName).min(1).max(8),
  onDelete: z.enum(REFERENTIAL).default('no action'),
  onUpdate: z.enum(REFERENTIAL).default('no action'),
})
export type ForeignKeyDef = z.infer<typeof foreignKeySchema>

export const indexSchema = z.object({
  name: newName.optional(),
  columns: z.array(oldName).min(1).max(8),
  unique: z.boolean().default(false),
  method: z.enum(['btree', 'hash', 'gin', 'gist', 'hnsw', 'ivfflat']).default('btree'),
})
export type IndexDef = z.infer<typeof indexSchema>

export const tableSchema = z.object({
  schema: oldName.default('public'),
  name: newName,
  comment: z.string().max(500).optional(),
  columns: z.array(columnSchema).min(1, 'Add at least one column').max(200),
  primaryKey: z.array(oldName).max(8).default([]),
  foreignKeys: z.array(foreignKeySchema).max(50).default([]),
  indexes: z.array(indexSchema).max(50).default([]),
})
export type TableDef = z.infer<typeof tableSchema>

const target = { schema: oldName.default('public'), table: oldName }

export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('createTable'), table: tableSchema }),
  z.object({ action: z.literal('dropTable'), ...target, cascade: z.boolean().default(false) }),
  z.object({ action: z.literal('renameTable'), ...target, to: newName }),
  z.object({ action: z.literal('truncate'), ...target, restartIdentity: z.boolean().default(false), cascade: z.boolean().default(false) }),
  z.object({ action: z.literal('duplicate'), ...target, to: newName, withData: z.boolean().default(false) }),
  z.object({ action: z.literal('addColumn'), ...target, column: columnSchema }),
  z.object({ action: z.literal('dropColumn'), ...target, column: oldName }),
  z.object({ action: z.literal('renameColumn'), ...target, column: oldName, to: newName }),
  z.object({
    action: z.literal('alterColumn'), ...target, column: oldName,
    type: typeField.optional(), nullable: z.boolean().optional(), default: defaultSchema.nullable().optional(),
  }),
  z.object({ action: z.literal('addIndex'), ...target, index: indexSchema }),
  z.object({ action: z.literal('dropIndex'), schema: oldName.default('public'), name: oldName }),
  z.object({ action: z.literal('addForeignKey'), ...target, foreignKey: foreignKeySchema }),
  z.object({ action: z.literal('dropConstraint'), ...target, name: oldName }),
])
export type DesignAction = z.infer<typeof actionSchema>

function assertUserSchema(schema: string): void {
  if (schema.startsWith('pg_') || schema === 'information_schema') throw new DesignError('schema', 'That schema is not available')
}

/** Constraint and index names made from the table and columns, cut to Postgres' 63 characters. */
const autoName = (table: string, columns: string[], suffix: string) => {
  const tail = `_${suffix}`
  return `${table}_${columns.join('_')}`.slice(0, 63 - tail.length) + tail
}

function defaultSql(d: DefaultSpec): string {
  return d.kind === 'expr' ? d.value : `'${d.value.replace(/'/g, "''")}'`
}

function columnSql(c: ColumnDef): string {
  const parts = [quote(c.name), c.type]
  if (c.identity) {
    if (!/^(smallint|integer|bigint)$/.test(c.type)) throw new DesignError(`column.${c.name}`, 'Auto-numbering needs a whole-number column')
    parts.push(`GENERATED ${c.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`)
  }
  if (!c.nullable) parts.push('NOT NULL')
  if (c.default) {
    if (c.identity) throw new DesignError(`column.${c.name}`, 'An auto-numbered column cannot also have a default')
    parts.push(`DEFAULT ${defaultSql(c.default)}`)
  }
  return parts.join(' ')
}

const fkSql = (table: string, fk: ForeignKeyDef) =>
  `CONSTRAINT ${quote(fk.name ?? autoName(table, fk.columns, 'fkey'))} FOREIGN KEY (${fk.columns.map(quote).join(', ')}) ` +
  `REFERENCES ${qualified(fk.refSchema, fk.refTable)} (${fk.refColumns.map(quote).join(', ')}) ` +
  `ON DELETE ${fk.onDelete.toUpperCase()} ON UPDATE ${fk.onUpdate.toUpperCase()}`

function indexSql(schema: string, table: string, ix: IndexDef): string {
  if (ix.unique && ix.method !== 'btree') throw new DesignError('index', 'Only a btree index can be unique')
  const name = ix.name ?? autoName(table, ix.columns, 'idx')
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${qualified(schema, table)} USING ${ix.method} (${ix.columns.map(quote).join(', ')})`
}

function checkFk(fk: ForeignKeyDef, have: Set<string>): void {
  if (fk.columns.length !== fk.refColumns.length) throw new DesignError('foreignKey', 'Pick as many referenced columns as columns')
  for (const c of fk.columns) if (!have.has(c)) throw new DesignError('foreignKey', `There is no column "${c}"`)
}

function createTableSql(t: TableDef): string[] {
  assertUserSchema(t.schema)
  const names = t.columns.map((c) => c.name)
  const have = new Set(names)
  if (have.size !== names.length) throw new DesignError('columns', 'Two columns have the same name')
  for (const c of t.primaryKey) if (!have.has(c)) throw new DesignError('primaryKey', `There is no column "${c}"`)
  for (const ix of t.indexes) for (const c of ix.columns) if (!have.has(c)) throw new DesignError('index', `There is no column "${c}"`)

  const lines = t.columns.map(columnSql)
  if (t.primaryKey.length) lines.push(`CONSTRAINT ${quote(`${t.name}_pkey`.slice(0, 63))} PRIMARY KEY (${t.primaryKey.map(quote).join(', ')})`)
  for (const c of t.columns) if (c.unique) lines.push(`CONSTRAINT ${quote(autoName(t.name, [c.name], 'key'))} UNIQUE (${quote(c.name)})`)
  for (const fk of t.foreignKeys) {
    checkFk(fk, have)
    lines.push(fkSql(t.name, fk))
  }

  const out = [`CREATE TABLE ${qualified(t.schema, t.name)} (\n  ${lines.join(',\n  ')}\n)`]
  for (const ix of t.indexes) out.push(indexSql(t.schema, t.name, ix))
  if (t.comment?.trim()) out.push(`COMMENT ON TABLE ${qualified(t.schema, t.name)} IS '${t.comment.trim().replace(/'/g, "''")}'`)
  return out
}

/** Every statement an action runs, in order. */
export function buildStatements(action: DesignAction): string[] {
  if (action.action === 'createTable') return createTableSql(action.table)
  assertUserSchema(action.schema)
  if (action.action === 'dropIndex') return [`DROP INDEX ${qualified(action.schema, action.name)}`]

  const t = qualified(action.schema, action.table)
  switch (action.action) {
    case 'dropTable':
      return [`DROP TABLE ${t}${action.cascade ? ' CASCADE' : ''}`]
    case 'renameTable':
      return [`ALTER TABLE ${t} RENAME TO ${quote(action.to)}`]
    case 'truncate':
      return [`TRUNCATE TABLE ${t}${action.restartIdentity ? ' RESTART IDENTITY' : ''}${action.cascade ? ' CASCADE' : ''}`]
    case 'duplicate': {
      const copy = qualified(action.schema, action.to)
      return [`CREATE TABLE ${copy} (LIKE ${t} INCLUDING ALL)`, ...(action.withData ? [`INSERT INTO ${copy} SELECT * FROM ${t}`] : [])]
    }
    case 'addColumn': {
      const out = [`ALTER TABLE ${t} ADD COLUMN ${columnSql(action.column)}`]
      if (action.column.unique) out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${quote(autoName(action.table, [action.column.name], 'key'))} UNIQUE (${quote(action.column.name)})`)
      return out
    }
    case 'dropColumn':
      return [`ALTER TABLE ${t} DROP COLUMN ${quote(action.column)}`]
    case 'renameColumn':
      return [`ALTER TABLE ${t} RENAME COLUMN ${quote(action.column)} TO ${quote(action.to)}`]
    case 'alterColumn': {
      const col = quote(action.column)
      const out: string[] = []
      if (action.type) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${action.type} USING ${col}::${action.type}`)
      if (action.nullable !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${action.nullable ? 'DROP' : 'SET'} NOT NULL`)
      if (action.default !== undefined) out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${action.default ? `SET DEFAULT ${defaultSql(action.default)}` : 'DROP DEFAULT'}`)
      if (out.length === 0) throw new DesignError('column', 'Nothing to change')
      return out
    }
    case 'addIndex':
      return [indexSql(action.schema, action.table, action.index)]
    case 'addForeignKey':
      checkFk(action.foreignKey, new Set(action.foreignKey.columns))
      return [`ALTER TABLE ${t} ADD ${fkSql(action.table, action.foreignKey)}`]
    case 'dropConstraint':
      return [`ALTER TABLE ${t} DROP CONSTRAINT ${quote(action.name)}`]
  }
}

/** Why an action needs the table name typed back, or null. */
export function destructiveReason(action: DesignAction): string | null {
  switch (action.action) {
    case 'dropTable':
      return 'Deletes the table and all its rows'
    case 'truncate':
      return 'Deletes every row in the table'
    case 'dropColumn':
      return 'Deletes the column and everything stored in it'
    case 'alterColumn':
      return action.type ? 'Converting a column can lose or reject data' : null
    default:
      return null
  }
}

/** The table a destructive action is about, which is what the person types to confirm. */
export const confirmTarget = (action: DesignAction): string | null =>
  action.action === 'createTable' || action.action === 'dropIndex' ? null : action.table
