/**
 * Builds MySQL table-structure SQL from the same typed requests as PostgreSQL. Nothing here accepts
 * SQL text. One request becomes one statement wherever MySQL allows it, because each statement commits.
 * The same file runs in the gateway and the portal; a test keeps them equal.
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

const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``
const literal = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`

const newName = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/, 'Use lowercase letters, numbers and underscores, starting with a letter')
const oldName = z.string().min(1).max(64)

const ALIASES: Record<string, string> = { integer: 'int', bool: 'boolean', numeric: 'decimal', 'double precision': 'double' }
const INTS = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint'])
const PLAIN = new Set(['boolean', 'float', 'double', 'tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'date', 'year', 'json'])

const enumValues = (body: string): string[] | null => {
  const out: string[] = []
  const re = /\s*'((?:[^'\\]|'')*)'\s*(,|$)/y
  let at = 0
  while (at < body.length) {
    re.lastIndex = at
    const m = re.exec(body)
    if (!m) return null
    out.push(m[1] as string)
    at = re.lastIndex
    if (m[2] === '') break
  }
  return out.length >= 1 && out.length <= 255 && out.every((v) => v.length <= 255) ? out : null
}

/** The type as MySQL should receive it, or null when it is not one of the offered kinds. */
export function normalizeType(raw: string): string | null {
  let t = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  const enumMatch = /^(enum|set)\(([\s\S]*)\)$/.exec(raw.trim())
  if (enumMatch) {
    const kind = (enumMatch[1] as string).toLowerCase()
    const values = enumValues(enumMatch[2] as string)
    if (!values || (kind === 'set' && values.length > 64)) return null
    return `${kind}(${values.map((v) => `'${v}'`).join(',')})`
  }
  const unsigned = t.endsWith(' unsigned')
  if (unsigned) t = t.slice(0, -9)
  t = ALIASES[t] ?? t.replace(/^numeric(?=\()/, 'decimal')
  const sign = unsigned ? ' unsigned' : ''

  if (INTS.has(t)) return `${t}${sign}`
  if (PLAIN.has(t)) return unsigned ? null : t
  let m = /^(decimal)(?:\((\d{1,2})(?:, ?(\d{1,2}))?\))?$/.exec(t)
  if (m) {
    if (!m[2]) return `decimal${sign}`
    const p = Number(m[2])
    const s = m[3] ? Number(m[3]) : 0
    return p >= 1 && p <= 65 && s <= 30 && s <= p ? `decimal(${p},${s})${sign}` : null
  }
  if (unsigned) return null
  m = /^(char|binary)\((\d{1,3})\)$/.exec(t)
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 255 ? `${m[1]}(${m[2]})` : null
  m = /^varchar\((\d{1,5})\)$/.exec(t)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 16_383 ? `varchar(${m[1]})` : null
  m = /^varbinary\((\d{1,5})\)$/.exec(t)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 65_535 ? `varbinary(${m[1]})` : null
  m = /^bit\((\d{1,2})\)$/.exec(t)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 64 ? `bit(${m[1]})` : null
  m = /^(time|datetime|timestamp)(?:\(([0-6])\))?$/.exec(t)
  if (m) return m[2] ? `${m[1]}(${m[2]})` : (m[1] as string)
  return null
}

const typeField = z.string().transform((v, ctx) => {
  const t = normalizeType(v)
  if (!t) ctx.addIssue({ code: 'custom', message: `"${v}" is not a type you can pick here` })
  return t ?? ''
})

/** The designer offers one shared list of defaults; these are what they mean in MySQL. */
const EXPRESSION_SQL: Record<string, string> = {
  'now()': 'CURRENT_TIMESTAMP',
  current_timestamp: 'CURRENT_TIMESTAMP',
  current_date: '(CURRENT_DATE)',
  'gen_random_uuid()': '(UUID())',
  'uuid()': '(UUID())',
  true: 'TRUE',
  false: 'FALSE',
}
const EXPRESSIONS = ['now()', 'current_timestamp', 'current_date', 'gen_random_uuid()', 'uuid()', 'true', 'false'] as const

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
  onUpdateNow: z.boolean().default(false),
})
export type ColumnDef = z.infer<typeof columnSchema>

const REFERENTIAL = ['no action', 'restrict', 'cascade', 'set null'] as const

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
  method: z.enum(['btree']).default('btree'),
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

/** A column as it stands, because MySQL restates the whole column to change part of it. */
export const currentColumnSchema = z.object({
  type: z.string().min(1).max(4000),
  nullable: z.boolean(),
  /** Ready-to-use SQL such as `'x'` or `(UUID())`, or null. */
  defaultSql: z.string().max(2000).nullable(),
  extra: z.string().max(200).default(''),
  collation: z.string().max(64).nullable().default(null),
})
export type CurrentColumn = z.infer<typeof currentColumnSchema>

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
    current: currentColumnSchema.optional(),
  }),
  z.object({ action: z.literal('addIndex'), ...target, index: indexSchema }),
  z.object({ action: z.literal('dropIndex'), schema: oldName.default('public'), table: oldName.optional(), name: oldName }),
  z.object({ action: z.literal('addForeignKey'), ...target, foreignKey: foreignKeySchema }),
  z.object({ action: z.literal('dropConstraint'), ...target, name: oldName }),
])
export type DesignAction = z.infer<typeof actionSchema>

const autoName = (table: string, columns: string[], suffix: string) => {
  const tail = `_${suffix}`
  return `${table}_${columns.join('_')}`.slice(0, 64 - tail.length) + tail
}

const NO_LITERAL_DEFAULT = /^(tiny|medium|long)?(text|blob)$|^json$/

function defaultSql(d: DefaultSpec, type: string, name: string): string {
  if (d.kind === 'expr') return EXPRESSION_SQL[d.value] as string
  if (NO_LITERAL_DEFAULT.test(type)) throw new DesignError(`column.${name}`, 'This kind of column cannot have a fixed default in MySQL')
  return literal(d.value)
}

const INT_TYPE = /^(tinyint|smallint|mediumint|int|bigint)( unsigned)?$/

function columnSql(c: ColumnDef): string {
  const parts = [quote(c.name), c.type]
  if (!c.nullable) parts.push('NOT NULL')
  if (c.identity) {
    if (!INT_TYPE.test(c.type)) throw new DesignError(`column.${c.name}`, 'Auto-numbering needs a whole-number column')
    if (c.default) throw new DesignError(`column.${c.name}`, 'An auto-numbered column cannot also have a default')
    parts.push('AUTO_INCREMENT')
  }
  if (c.default) parts.push(`DEFAULT ${defaultSql(c.default, c.type, c.name)}`)
  if (c.onUpdateNow) {
    if (!/^(datetime|timestamp)/.test(c.type)) throw new DesignError(`column.${c.name}`, 'Only date-and-time columns can update themselves')
    parts.push('ON UPDATE CURRENT_TIMESTAMP')
  }
  return parts.join(' ')
}

const fkSql = (table: string, fk: ForeignKeyDef) =>
  `CONSTRAINT ${quote(fk.name ?? autoName(table, fk.columns, 'fkey'))} FOREIGN KEY (${fk.columns.map(quote).join(', ')}) ` +
  `REFERENCES ${quote(fk.refTable)} (${fk.refColumns.map(quote).join(', ')}) ` +
  `ON DELETE ${fk.onDelete.toUpperCase()} ON UPDATE ${fk.onUpdate.toUpperCase()}`

function checkFk(fk: ForeignKeyDef, have: Set<string>): void {
  if (fk.columns.length !== fk.refColumns.length) throw new DesignError('foreignKey', 'Pick as many referenced columns as columns')
  for (const c of fk.columns) if (!have.has(c)) throw new DesignError('foreignKey', `There is no column "${c}"`)
}

const LONG_TYPE = /^(tiny|medium|long)?(text|blob)$/
const INDEX_PREFIX = 191

/** Column list for an index. Long text columns can only be indexed on their first characters. */
function indexColumns(ix: IndexDef, types?: Map<string, string>): string {
  return ix.columns
    .map((c) => {
      if (!LONG_TYPE.test(types?.get(c) ?? '')) return quote(c)
      if (ix.unique) throw new DesignError('index', `"${c}" is long text, so it cannot be unique. Use a varchar column instead.`)
      return `${quote(c)}(${INDEX_PREFIX})`
    })
    .join(', ')
}

function createTableSql(t: TableDef): string[] {
  const names = t.columns.map((c) => c.name)
  const have = new Set(names)
  if (have.size !== names.length) throw new DesignError('columns', 'Two columns have the same name')
  for (const c of t.primaryKey) if (!have.has(c)) throw new DesignError('primaryKey', `There is no column "${c}"`)
  for (const ix of t.indexes) for (const c of ix.columns) if (!have.has(c)) throw new DesignError('index', `There is no column "${c}"`)

  const autos = t.columns.filter((c) => c.identity)
  if (autos.length > 1) throw new DesignError('columns', 'A MySQL table can have only one auto-numbered column')
  for (const c of autos) {
    if (!t.primaryKey.includes(c.name) && !c.unique) throw new DesignError(`column.${c.name}`, 'An auto-numbered column must be the primary key or unique')
  }

  const types = new Map(t.columns.map((c) => [c.name, c.type]))
  const lines = t.columns.map(columnSql)
  if (t.primaryKey.length) lines.push(`PRIMARY KEY (${indexColumns({ columns: t.primaryKey, unique: true, method: 'btree' }, types)})`)
  for (const c of t.columns) if (c.unique) lines.push(`UNIQUE KEY ${quote(autoName(t.name, [c.name], 'key'))} (${indexColumns({ columns: [c.name], unique: true, method: 'btree' }, types)})`)
  for (const ix of t.indexes) lines.push(`${ix.unique ? 'UNIQUE ' : ''}KEY ${quote(ix.name ?? autoName(t.name, ix.columns, 'idx'))} (${indexColumns(ix, types)})`)
  for (const fk of t.foreignKeys) {
    checkFk(fk, have)
    lines.push(fkSql(t.name, fk))
  }
  const comment = t.comment?.trim() ? ` COMMENT=${literal(t.comment.trim())}` : ''
  return [`CREATE TABLE ${quote(t.name)} (\n  ${lines.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4${comment}`]
}

function alterColumnSql(t: string, a: Extract<DesignAction, { action: 'alterColumn' }>): string[] {
  const col = quote(a.column)
  if (a.type === undefined && a.nullable === undefined) {
    if (a.default === undefined) throw new DesignError('column', 'Nothing to change')
    const type = a.current?.type.toLowerCase() ?? ''
    return [`ALTER TABLE ${t} ALTER COLUMN ${col} ${a.default ? `SET DEFAULT ${defaultSql(a.default, type, a.column)}` : 'DROP DEFAULT'}`]
  }
  // The preview in the portal may not know the column yet; the gateway always fills this in.
  const cur = a.current
  const type = a.type ?? cur?.type ?? '<current type>'
  const nullable = a.nullable ?? cur?.nullable ?? true
  const dflt = a.default === undefined ? cur?.defaultSql ?? null : a.default ? defaultSql(a.default, type, a.column) : null
  const extra = (cur?.extra ?? '').replace(/DEFAULT_GENERATED/i, '').trim()
  const collate = cur?.collation && a.type === undefined ? ` COLLATE ${cur.collation}` : ''
  const parts = [`ALTER TABLE ${t} MODIFY COLUMN ${col} ${type}${collate}`, nullable ? 'NULL' : 'NOT NULL']
  if (dflt) parts.push(`DEFAULT ${dflt}`)
  if (extra) parts.push(extra)
  return [parts.join(' ')]
}

export interface BuildContext {
  /** Column types of the table being changed, known in the gateway. */
  columnTypes?: Map<string, string>
}

/** Every statement an action runs, in order. */
export function buildStatements(action: DesignAction, ctx: BuildContext = {}): string[] {
  if (action.action === 'createTable') return createTableSql(action.table)
  if (action.action === 'dropIndex') {
    if (!action.table) throw new DesignError('index', 'MySQL needs the table this index belongs to')
    return [`DROP INDEX ${quote(action.name)} ON ${quote(action.table)}`]
  }

  const t = quote(action.table)
  switch (action.action) {
    case 'dropTable':
      if (action.cascade) throw new DesignError('table', 'MySQL cannot delete the tables that depend on this one for you. Remove those links first.')
      return [`DROP TABLE ${t}`]
    case 'renameTable':
      return [`RENAME TABLE ${t} TO ${quote(action.to)}`]
    case 'truncate':
      if (action.cascade) throw new DesignError('table', 'MySQL cannot empty the tables that depend on this one for you. Remove those links first.')
      return [`TRUNCATE TABLE ${t}`]
    case 'duplicate': {
      const copy = quote(action.to)
      return [`CREATE TABLE ${copy} LIKE ${t}`, ...(action.withData ? [`INSERT INTO ${copy} SELECT * FROM ${t}`] : [])]
    }
    case 'addColumn': {
      if (action.column.identity && !action.column.unique) throw new DesignError(`column.${action.column.name}`, 'An auto-numbered column must be unique')
      const unique = action.column.unique ? `, ADD UNIQUE KEY ${quote(autoName(action.table, [action.column.name], 'key'))} (${quote(action.column.name)})` : ''
      return [`ALTER TABLE ${t} ADD COLUMN ${columnSql(action.column)}${unique}`]
    }
    case 'dropColumn':
      return [`ALTER TABLE ${t} DROP COLUMN ${quote(action.column)}`]
    case 'renameColumn':
      return [`ALTER TABLE ${t} RENAME COLUMN ${quote(action.column)} TO ${quote(action.to)}`]
    case 'alterColumn':
      return alterColumnSql(t, action)
    case 'addIndex':
      return [`CREATE ${action.index.unique ? 'UNIQUE ' : ''}INDEX ${quote(action.index.name ?? autoName(action.table, action.index.columns, 'idx'))} ON ${t} (${indexColumns(action.index, ctx.columnTypes)})`]
    case 'addForeignKey':
      checkFk(action.foreignKey, new Set(action.foreignKey.columns))
      return [`ALTER TABLE ${t} ADD ${fkSql(action.table, action.foreignKey)}`]
    case 'dropConstraint':
      return [`ALTER TABLE ${t} DROP CONSTRAINT ${quote(action.name)}`]
  }
}

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

export const confirmTarget = (action: DesignAction): string | null =>
  action.action === 'createTable' || action.action === 'dropIndex' ? null : action.table
