/**
 * Reads SQL text without a parser: splits it into statements, hides literals for logs, and says
 * whether a statement is refused or needs a confirmation. This is a guardrail for people. The real
 * boundary is Postgres itself: the app role has no superuser rights, so a statement this misses
 * still cannot reach files, roles or other databases.
 *
 * The gateway and the portal carry the same file; a test keeps them identical.
 */

export type StatementKind = 'select' | 'dml' | 'ddl' | 'admin'

export interface Classified {
  /** The statement as written, without its trailing semicolon. */
  sql: string
  /** Safe to log: comments gone, string literals and dollar-quoted bodies replaced by a dot-dot-dot. */
  elided: string
  verb: string
  kind: StatementKind
  /** Changes data or structure, so it needs a write session. */
  writes: boolean
  /** Why this needs a confirmation, or null. */
  destructive: string | null
  /** Why the web console will not run it, or null. */
  refused: string | null
  returnsRows: boolean
}

interface Token {
  w: string
  depth: number
}

export interface Piece {
  sql: string
  elided: string
  tokens: Token[]
}

const EXTENSIONS = ['pgcrypto', 'uuid-ossp', 'pg_trgm', 'citext', 'hstore', 'unaccent', 'btree_gin', 'btree_gist', 'pg_stat_statements', 'vector']

const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c)

/** Words of a dollar-quoted body count toward the refusal checks but never reach the log. */
function wordsOf(text: string, depth: number): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.push({ w: m[0].toLowerCase(), depth })
  return out
}

export function splitStatements(input: string): Piece[] {
  const pieces: Piece[] = []
  let start = 0
  let elided = ''
  let tokens: Token[] = []
  let depth = 0
  let i = 0

  const flush = (end: number) => {
    if (tokens.length > 0) pieces.push({ sql: input.slice(start, end).trim(), elided: elided.replace(/\s+/g, ' ').trim(), tokens })
    elided = ''
    tokens = []
    depth = 0
  }

  while (i < input.length) {
    const c = input[i] as string
    const next = input[i + 1]

    if (c === '-' && next === '-') {
      while (i < input.length && input[i] !== '\n') i++
      elided += ' '
      continue
    }
    if (c === '/' && next === '*') {
      let nest = 1
      i += 2
      while (i < input.length && nest > 0) {
        if (input[i] === '/' && input[i + 1] === '*') {
          nest++
          i += 2
        } else if (input[i] === '*' && input[i + 1] === '/') {
          nest--
          i += 2
        } else i++
      }
      elided += ' '
      continue
    }
    if (c === "'") {
      // E'...' strings treat a backslash as an escape; plain ones only double the quote.
      const escape = /[eE]/.test(input[i - 1] ?? '') && !isWordChar(input[i - 2] ?? ' ')
      i++
      while (i < input.length) {
        if (escape && input[i] === '\\') i += 2
        else if (input[i] === "'" && input[i + 1] === "'") i += 2
        else if (input[i] === "'") break
        else i++
      }
      i++
      elided += "'…'"
      continue
    }
    if (c === '"') {
      const from = i
      i++
      while (i < input.length) {
        if (input[i] === '"' && input[i + 1] === '"') i += 2
        else if (input[i] === '"') break
        else i++
      }
      i++
      const quoted = input.slice(from, i)
      elided += quoted
      // Quoted names can never be keywords, so they carry a quote in their token.
      tokens.push({ w: quoted, depth })
      continue
    }
    if (c === '$' && !isWordChar(input[i - 1] ?? ' ')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i, i + 80))
      if (tag) {
        const close = input.indexOf(tag[0], i + tag[0].length)
        const bodyEnd = close === -1 ? input.length : close
        tokens.push(...wordsOf(input.slice(i + tag[0].length, bodyEnd), depth))
        i = close === -1 ? input.length : close + tag[0].length
        elided += `${tag[0]}…${tag[0]}`
        continue
      }
    }
    if (c === ';') {
      flush(i)
      i++
      start = i
      continue
    }
    if (isWordChar(c)) {
      let j = i
      while (j < input.length && isWordChar(input[j] ?? ' ')) j++
      const word = input.slice(i, j)
      // A leading digit means a number or a $1 parameter, not a keyword.
      if (/^[A-Za-z_]/.test(word)) tokens.push({ w: word.toLowerCase(), depth })
      elided += word
      i = j
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth = Math.max(0, depth - 1)
    elided += c
    i++
  }
  flush(input.length)
  return pieces
}

const TX_CONTROL = new Set(['begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release', 'prepare'])
const READ_VERBS = new Set(['select', 'show', 'values', 'table', 'explain'])
// Session settings change nothing stored, so they do not need a write session.
const NON_WRITING = new Set([...READ_VERBS, 'set', 'reset', 'discard'])
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge'])
const DML_VERBS = new Set(['insert', 'update', 'delete', 'merge', 'call', 'do'])
const DDL_VERBS = new Set(['create', 'alter', 'drop', 'truncate', 'comment', 'grant', 'revoke', 'reindex', 'cluster', 'refresh'])
const DANGEROUS_FUNCTIONS = new Set([
  'lo_import', 'lo_export', 'pg_read_file', 'pg_read_binary_file', 'pg_stat_file', 'pg_terminate_backend', 'pg_cancel_backend',
  'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal', 'pg_create_restore_point', 'set_config', 'pg_file_write',
])
const NOT_ALLOWED = "That statement isn't allowed in the web console. Connect with psql from your application network if you need it."

function refusalFor(tokens: Token[], allowed: readonly string[]): string | null {
  const [verb = '', second = '', third = ''] = tokens.map((t) => t.w)
  if (TX_CONTROL.has(verb)) return NOT_ALLOWED
  if (verb === 'copy' || verb === 'load') return NOT_ALLOWED
  if (verb === 'alter' && ['system', 'role', 'user', 'group', 'database', 'server', 'extension'].includes(second)) return NOT_ALLOWED
  if (verb === 'create' && ['role', 'user', 'group', 'server', 'foreign', 'tablespace', 'database', 'subscription', 'access', 'language'].includes(second)) return NOT_ALLOWED
  if (verb === 'drop' && ['role', 'user', 'group', 'server', 'foreign', 'tablespace', 'database', 'subscription'].includes(second)) return NOT_ALLOWED
  if (verb === 'import' && second === 'foreign') return NOT_ALLOWED
  if (verb === 'set' && ['role', 'session', 'transaction', 'default_transaction_read_only', 'transaction_read_only'].includes(second)) return NOT_ALLOWED
  if (verb === 'set' && second === 'local' && ['role', 'transaction_read_only', 'default_transaction_read_only'].includes(third)) return NOT_ALLOWED
  if (verb === 'create' && second === 'extension') {
    // The name may be quoted; strip quotes before the allow-list check.
    const rest = tokens.slice(2).map((t) => t.w.replace(/"/g, ''))
    const name = rest[0] === 'if' ? rest[3] : rest[0]
    if (!name || !allowed.includes(name)) return 'That extension is not available. The list of extensions you can turn on is under Settings.'
  }
  for (const { w } of tokens) {
    if (DANGEROUS_FUNCTIONS.has(w) || w.startsWith('dblink') || w.startsWith('pg_ls_')) return NOT_ALLOWED
  }
  return null
}

function destructiveFor(verb: string, tokens: Token[]): string | null {
  if (verb === 'drop') return 'Deletes an object and everything in it'
  if (verb === 'truncate') return 'Empties the whole table'
  const words = tokens.map((t) => t.w)
  if (verb === 'alter' && words[1] === 'table' && words.includes('drop')) return 'Removes a column or constraint'
  const changes = verb === 'delete' || verb === 'update' ? verb : verb === 'with' ? words.find((w) => w === 'delete' || w === 'update') : undefined
  if (changes) {
    const topWhere = tokens.some((t) => t.w === 'where' && (verb === 'with' || t.depth === 0))
    if (!topWhere) return changes === 'delete' ? 'Deletes every row' : 'Changes every row'
  }
  return null
}

export function classify(piece: Piece, allowedExtensions: readonly string[] = EXTENSIONS): Classified {
  const { tokens } = piece
  const verb = tokens[0]?.w ?? ''
  const words = tokens.map((t) => t.w)

  const innerWrites =
    verb === 'with' || verb === 'explain'
      ? words.some((w) => WRITE_WORDS.has(w)) && (verb === 'with' || words.some((w) => w === 'analyze' || w === 'analyse'))
      : false
  const writes = !NON_WRITING.has(verb) && verb !== 'with' ? true : innerWrites

  let kind: StatementKind = 'admin'
  if (DDL_VERBS.has(verb)) kind = 'ddl'
  else if (DML_VERBS.has(verb) || innerWrites) kind = 'dml'
  else if (READ_VERBS.has(verb) || verb === 'with') kind = 'select'

  return {
    sql: piece.sql,
    elided: piece.elided,
    verb,
    kind,
    writes,
    destructive: destructiveFor(verb, tokens),
    refused: refusalFor(tokens, allowedExtensions),
    returnsRows: READ_VERBS.has(verb) || verb === 'with' || words.includes('returning'),
  }
}

export function classifyScript(input: string): Classified[] {
  return splitStatements(input).map((p) => classify(p))
}
