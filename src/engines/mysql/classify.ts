/**
 * Reads MySQL text without a parser: splits statements, hides literals for logs, and says whether a
 * statement is refused or needs confirming. A guardrail for people; the account's rights are the boundary.
 * The gateway and the portal carry the same file; a test keeps them identical.
 */

export type StatementKind = 'select' | 'dml' | 'ddl' | 'admin'

export interface Classified {
  sql: string
  elided: string
  verb: string
  kind: StatementKind
  writes: boolean
  destructive: string | null
  refused: string | null
  returnsRows: boolean
  /** MySQL saves this at once and ends the open transaction. */
  impliesCommit: boolean
}

interface Token {
  w: string
  depth: number
}

export interface Piece {
  sql: string
  elided: string
  tokens: Token[]
  /** A string or comment never closed, or a semicolon inside code hidden in a comment. */
  broken: boolean
}

const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c)
const isSpace = (c: string | undefined) => c === undefined || /[\s\x00-\x1f]/.test(c)

export function splitStatements(input: string): Piece[] {
  const pieces: Piece[] = []
  let start = 0
  let elided = ''
  let tokens: Token[] = []
  let depth = 0
  let hidden = 0
  let broken = false
  let i = 0

  const flush = (end: number) => {
    if (tokens.length > 0 || broken) pieces.push({ sql: input.slice(start, end).trim(), elided: elided.replace(/\s+/g, ' ').trim(), tokens, broken })
    elided = ''
    tokens = []
    depth = 0
    broken = false
  }

  while (i < input.length) {
    const c = input[i] as string
    const next = input[i + 1]

    if (c === '#' || (c === '-' && next === '-' && isSpace(input[i + 2]))) {
      while (i < input.length && input[i] !== '\n') i++
      elided += ' '
      continue
    }
    if (hidden > 0 && c === '*' && next === '/') {
      hidden--
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      // MySQL runs what is inside /*! ... */, so it is read as code.
      const marker = /^\/\*(?:!\d{0,6}|M!\d{0,6})/.exec(input.slice(i, i + 12))
      if (marker) {
        hidden++
        i += marker[0].length
        continue
      }
      const close = input.indexOf('*/', i + 2)
      if (close === -1) {
        broken = true
        i = input.length
        continue
      }
      i = close + 2
      elided += ' '
      continue
    }
    if (c === "'" || c === '"') {
      i++
      let closed = false
      while (i < input.length) {
        if (input[i] === '\\') i += 2
        else if (input[i] === c && input[i + 1] === c) i += 2
        else if (input[i] === c) {
          closed = true
          break
        } else i++
      }
      i++
      if (!closed) broken = true
      elided += "'…'"
      continue
    }
    if (c === '`') {
      const from = i
      i++
      let closed = false
      while (i < input.length) {
        if (input[i] === '`' && input[i + 1] === '`') i += 2
        else if (input[i] === '`') {
          closed = true
          break
        } else i++
      }
      i++
      if (!closed) broken = true
      const quoted = input.slice(from, i)
      elided += quoted
      // Quoted names can never be keywords, so they keep their backticks in the token.
      tokens.push({ w: quoted, depth })
      continue
    }
    if (c === ';') {
      if (hidden > 0) broken = true
      flush(i)
      hidden = 0
      i++
      start = i
      continue
    }
    if (c === '@') {
      let j = i
      while (input[j] === '@') j++
      while (j < input.length && isWordChar(input[j] ?? ' ')) j++
      const word = input.slice(i, j)
      tokens.push({ w: word.toLowerCase(), depth })
      elided += word
      i = j
      continue
    }
    if (isWordChar(c)) {
      let j = i
      while (j < input.length && isWordChar(input[j] ?? ' ')) j++
      const word = input.slice(i, j)
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
  if (hidden > 0) broken = true
  flush(input.length)
  return pieces
}

const READ_VERBS = new Set(['select', 'show', 'desc', 'describe', 'explain', 'values', 'table', 'check', 'checksum', 'help'])
const DML_VERBS = new Set(['insert', 'replace', 'update', 'delete', 'call', 'do'])
const DDL_VERBS = new Set(['create', 'alter', 'drop', 'rename', 'truncate'])
const ADMIN_VERBS = new Set(['analyze', 'optimize'])
const ALLOWED_VERBS = new Set([...READ_VERBS, ...DML_VERBS, ...DDL_VERBS, ...ADMIN_VERBS, 'with', 'set'])

const ACCOUNT_OBJECTS = ['user', 'role', 'database', 'schema', 'tablespace', 'server', 'logfile', 'resource', 'spatial', 'undo', 'instance']
const DANGEROUS_FUNCTIONS = new Set(['load_file', 'get_lock', 'is_free_lock', 'is_used_lock', 'release_lock', 'release_all_locks', 'sys_exec', 'sys_eval', 'source_pos_wait', 'master_pos_wait', 'wait_for_executed_gtid_set'])
const SET_REFUSED = new Set([
  'global', 'persist', 'persist_only', '@@global', '@@persist', '@@persist_only', 'password', 'role', 'transaction', 'resource', 'default',
  'sql_mode', 'autocommit', 'sql_log_bin', 'transaction_read_only', 'tx_read_only', 'transaction_isolation', 'tx_isolation',
  'max_execution_time', 'sql_select_limit', 'lock_wait_timeout', 'innodb_lock_wait_timeout',
])
const SET_ALLOWED_FIRST = new Set(['names', 'character', 'charset', 'time_zone', 'foreign_key_checks', 'unique_checks', 'session', 'local', '@@session', '@@local'])

const NOT_ALLOWED = "That statement isn't allowed in the web console. Connect with the mysql client from your application network if you need it."

function refusalFor(piece: Piece): string | null {
  if (piece.broken) return 'This statement has a quote or comment that is never closed.'
  const words = piece.tokens.map((t) => t.w)
  const [verb = '', second = ''] = words
  if (!ALLOWED_VERBS.has(verb)) return NOT_ALLOWED
  if ((verb === 'create' || verb === 'alter' || verb === 'drop' || verb === 'rename') && ACCOUNT_OBJECTS.includes(second)) return NOT_ALLOWED
  if (verb === 'set') {
    if (words.some((w) => SET_REFUSED.has(w))) return NOT_ALLOWED
    if (!(second.startsWith('@') && !second.startsWith('@@')) && !SET_ALLOWED_FIRST.has(second)) return NOT_ALLOWED
  }
  for (let i = 0; i < words.length; i++) {
    if (DANGEROUS_FUNCTIONS.has(words[i] as string)) return NOT_ALLOWED
    if (words[i] === 'into' && (words[i + 1] === 'outfile' || words[i + 1] === 'dumpfile')) return NOT_ALLOWED
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

export function classify(piece: Piece): Classified {
  const words = piece.tokens.map((t) => t.w)
  const verb = words[0] ?? ''
  const innerWrites = verb === 'with' && words.some((w) => w === 'update' || w === 'delete')
  const settingWrites = verb === 'set' && words.some((w) => w === 'foreign_key_checks' || w === 'unique_checks')
  const writes = READ_VERBS.has(verb) || verb === 'with' || verb === 'set' ? innerWrites || settingWrites : true

  let kind: StatementKind = 'admin'
  if (DDL_VERBS.has(verb)) kind = 'ddl'
  else if (DML_VERBS.has(verb) || innerWrites) kind = 'dml'
  else if (READ_VERBS.has(verb) || verb === 'with') kind = 'select'

  const temporary = (verb === 'create' || verb === 'drop') && words[1] === 'temporary'
  return {
    sql: piece.sql,
    elided: piece.elided,
    verb,
    kind,
    writes,
    destructive: destructiveFor(verb, piece.tokens),
    refused: refusalFor(piece),
    returnsRows: READ_VERBS.has(verb) || ADMIN_VERBS.has(verb) || verb === 'call' || (verb === 'with' && !innerWrites),
    impliesCommit: (DDL_VERBS.has(verb) && !temporary) || ADMIN_VERBS.has(verb),
  }
}

export function classifyScript(input: string): Classified[] {
  return splitStatements(input).map(classify)
}
