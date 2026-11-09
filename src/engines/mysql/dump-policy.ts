/**
 * What a dump may contain. Server backups only have their DEFINERs rewritten; a file sent in by a
 * customer is checked statement by statement first, and one bad line refuses the whole file.
 */

/** Text with strings and plain comments gone and /*! markers opened, for looking at what would run. */
export function flatten(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    if (c === "'" || c === '"') {
      i++
      while (i < sql.length) {
        if (sql[i] === '\\') i += 2
        else if (sql[i] === c && sql[i + 1] === c) i += 2
        else if (sql[i] === c) break
        else i++
      }
      i++
      out += " '' "
    } else if (c === '`') {
      const from = i
      i++
      while (i < sql.length) {
        if (sql[i] === '`' && sql[i + 1] === '`') i += 2
        else if (sql[i] === '`') break
        else i++
      }
      i++
      out += sql.slice(from, i)
    } else if (c === '#' || (c === '-' && sql[i + 1] === '-' && /[\s\x00-\x1f]/.test(sql[i + 2] ?? ' '))) {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      const marker = /^\/\*(?:!\d{0,6}|M!\d{0,6})/.exec(sql.slice(i, i + 12))
      if (marker) {
        i += marker[0].length
        out += ' '
      } else {
        const close = sql.indexOf('*/', i + 2)
        i = close === -1 ? sql.length : close + 2
        out += ' '
      }
    } else if (c === '*' && sql[i + 1] === '/') {
      i += 2
      out += ' '
    } else {
      out += c
      i++
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

const DEFINER_RE = /DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|[A-Za-z0-9_$.]+)(?:\s*@\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|[A-Za-z0-9_$.%]+))?/gi
const ROUTINE_HEAD_RE = /^\s*(?:\/\*!\d{0,6}\s*)*(?:CREATE|ALTER)\b/i

/** Sets every DEFINER to `to`, or removes it when `to` is null. Only statements that can carry one are touched. */
export function rewriteDefiner(sql: string, to: string | null): string {
  if (!ROUTINE_HEAD_RE.test(sql) || !/DEFINER/i.test(sql)) return sql
  return sql.replace(DEFINER_RE, to === null ? '' : `DEFINER=${to}`)
}

const SKIPPED_SET = /^SET\s+(?:@@GLOBAL\.GTID_PURGED|@@SESSION\.SQL_LOG_BIN|@@SQL_LOG_BIN|SQL_LOG_BIN|GLOBAL\s+GTID_PURGED)\b/i
const SAFE_SET_VARS = /^(?:NAMES|CHARACTER|CHARSET|CHARACTER_SET_[A-Z]+|COLLATION_[A-Z]+|TIME_ZONE|FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|SQL_MODE|SQL_NOTES|SQL_AUTO_IS_NULL|AUTOCOMMIT|@[A-Z0-9_$.]+|@@SESSION\.(?:FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|SQL_MODE))$/i
const BAD_MODES = /NO_BACKSLASH_ESCAPES|ANSI_QUOTES/i

const NAME = '(?:`(?:[^`]|``)+`|[A-Za-z0-9_$]+)'
const QUALIFIED_RE = new RegExp(`^(?:CREATE(?:\\s+OR\\s+REPLACE)?(?:\\s+TEMPORARY)?(?:\\s+ALGORITHM\\s*=\\s*\\w+)?(?:\\s+SQL\\s+SECURITY\\s+\\w+)?\\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)(?:\\s+IF\\s+NOT\\s+EXISTS)?|ALTER\\s+TABLE|DROP\\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT)(?:\\s+IF\\s+EXISTS)?|INSERT\\s+(?:IGNORE\\s+)?INTO|REPLACE\\s+INTO|LOCK\\s+TABLES)\\s+(${NAME})\\.`, 'i')
const unquote = (name: string) => name.replace(/^`|`$/g, '').replace(/``/g, '`')

const ALLOWED_HEAD = /^(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+TEMPORARY)?(?:\s+ALGORITHM\s*=\s*\w+)?(?:\s+SQL\s+SECURITY\s+\w+)?\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT|INDEX)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION|EVENT|INDEX)\b|INSERT\b|REPLACE\b|LOCK\s+TABLES\b|UNLOCK\s+TABLES\b|START\s+TRANSACTION\b|BEGIN\s*$|COMMIT\b|SET\b)/i
const REFUSED_INSIDE = /\b(?:DATA\s+DIRECTORY|INDEX\s+DIRECTORY|INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\(|LOAD\s+DATA)\b/i

export type Verdict = { action: 'run' } | { action: 'skip' } | { action: 'refuse'; reason: string }

const refuse = (reason: string): Verdict => ({ action: 'refuse', reason })

/** Decides what happens to one statement of a customer's file. `db` is the only database it may name. */
export function checkUploaded(sql: string, db: string): Verdict {
  const flat = flatten(sql)
  if (!flat) return { action: 'skip' }
  const head = flat.slice(0, 40).split(' ').slice(0, 3).join(' ')

  if (/^(?:USE\b|CREATE\s+(?:DATABASE|SCHEMA)\b)/i.test(flat)) return { action: 'skip' }
  if (SKIPPED_SET.test(flat)) return { action: 'skip' }

  // Procedure bodies count too: a stored GRANT would run later, so these are looked for anywhere.
  if (/\b(?:GRANT|REVOKE|PREPARE|DEALLOCATE)\b/i.test(flat) || /\bEXECUTE\s+[A-Za-z@`]/i.test(flat)) return refuse(head)
  if (!ALLOWED_HEAD.test(flat)) return refuse(head)
  if (REFUSED_INSIDE.test(flat)) return refuse(head)

  if (/^SET\b/i.test(flat)) {
    for (const part of flat.slice(3).split(',')) {
      const name = part.trim().split(/[\s=:]/)[0] ?? ''
      if (!SAFE_SET_VARS.test(name)) return refuse(head)
    }
    if (BAD_MODES.test(sql)) return refuse('SET sql_mode')
  }
  if (/\bENGINE\s*=\s*(?!InnoDB\b)\w+/i.test(flat) && /^CREATE\b/i.test(flat)) return refuse('a table that does not use InnoDB')

  const qualified = QUALIFIED_RE.exec(flat)
  if (qualified && unquote(qualified[1] as string) !== db) return refuse(`another database (${unquote(qualified[1] as string)})`)
  return { action: 'run' }
}
