/**
 * Reads a SQL dump one statement at a time without loading it. Text is decoded as latin1, one byte to
 * one character, so a connection in binary mode sends the file's bytes back exactly as they were.
 */
export const MAX_STATEMENT_CHARS = 64 * 1024 * 1024
const LOOK_AHEAD = 128

export class DumpError extends Error {}

export interface DumpStatement {
  sql: string
  /** Counting from 1, for messages about the file. */
  line: number
}

type State = 'code' | 'hidden' | 'single' | 'double' | 'tick' | 'line' | 'block'
const QUOTES: Partial<Record<State, number>> = { single: 39, double: 34, tick: 96 }
const isBlank = (c: number) => c === 32 || c === 9 || c === 13 || c === 10

/** Yields statements in file order. `DELIMITER` is obeyed here and never reaches the server. */
export async function* readStatements(chunks: AsyncIterable<string>): AsyncGenerator<DumpStatement> {
  const source = chunks[Symbol.asyncIterator]()
  let buf = ''
  let pos = 0
  let start = 0
  let ended = false

  // Keeps enough text ahead that a marker cut across two chunks is still seen whole.
  const fill = async () => {
    while (!ended && buf.length - pos < LOOK_AHEAD) {
      const next = await source.next()
      if (next.done) {
        ended = true
        return
      }
      buf = buf.slice(start) + next.value
      pos -= start
      start = 0
      if (buf.length > MAX_STATEMENT_CHARS) throw new DumpError(`A statement near line ${firstLine} is larger than 64 MB`)
    }
  }

  let delimiter = ';'
  let state: State = 'code'
  let resume: State = 'code'
  let hasCode = false
  let line = 1
  let firstLine = 1

  const isLineComment = (at: number) => {
    const c = buf.charCodeAt(at)
    if (c === 35) return true
    if (c !== 45 || buf.charCodeAt(at + 1) !== 45) return false
    const after = buf.charCodeAt(at + 2)
    return Number.isNaN(after) || after <= 32
  }

  for (;;) {
    if (buf.length - pos < LOOK_AHEAD) await fill()
    if (pos >= buf.length) break
    const c = buf.charCodeAt(pos)

    if (state === 'line') {
      if (c === 10) {
        line++
        state = resume
        if (!hasCode) start = pos + 1
      }
      pos++
      continue
    }
    if (state === 'block') {
      if (c === 10) line++
      if (c === 42 && buf.charCodeAt(pos + 1) === 47) {
        pos += 2
        state = resume
        if (!hasCode) start = pos
      } else pos++
      continue
    }
    const quote = QUOTES[state]
    if (quote !== undefined) {
      if (c === 10) line++
      if (c === 92 && state !== 'tick') {
        if (buf.charCodeAt(pos + 1) === 10) line++
        pos += 2
      } else if (c === quote && buf.charCodeAt(pos + 1) === quote) pos += 2
      else {
        if (c === quote) state = resume
        pos++
      }
      continue
    }

    // Between statements: blanks, comments and DELIMITER lines belong to nothing.
    if (!hasCode) {
      if (isBlank(c)) {
        if (c === 10) line++
        pos++
        start = pos
        continue
      }
      if (isLineComment(pos)) {
        resume = 'code'
        state = 'line'
        pos++
        continue
      }
      if (c === 47 && buf.charCodeAt(pos + 1) === 42 && buf[pos + 2] !== '!' && !(buf[pos + 2] === 'M' && buf[pos + 3] === '!')) {
        resume = 'code'
        state = 'block'
        pos += 2
        continue
      }
      const directive = /^delimiter[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(buf.slice(pos, pos + LOOK_AHEAD))
      if (directive) {
        delimiter = directive[1] as string
        pos += directive[0].length
        start = pos
        if (directive[2]) line++
        continue
      }
      hasCode = true
      firstLine = line
    }

    if (c === 10) line++
    if (c === 39 || c === 34 || c === 96) {
      resume = state
      state = c === 39 ? 'single' : c === 34 ? 'double' : 'tick'
      pos++
    } else if (state === 'hidden' && c === 42 && buf.charCodeAt(pos + 1) === 47) {
      state = 'code'
      pos += 2
    } else if (isLineComment(pos)) {
      resume = state
      state = 'line'
      pos++
    } else if (c === 47 && buf.charCodeAt(pos + 1) === 42) {
      const third = buf[pos + 2]
      if (third === '!' || (third === 'M' && buf[pos + 3] === '!')) {
        state = 'hidden'
        pos += third === '!' ? 3 : 4
      } else {
        resume = state
        state = 'block'
        pos += 2
      }
    } else if (state === 'code' && buf.startsWith(delimiter, pos)) {
      const sql = buf.slice(start, pos).trim()
      pos += delimiter.length
      start = pos
      hasCode = false
      if (sql) yield { sql, line: firstLine }
    } else pos++
  }

  if (state !== 'code' && state !== 'line') throw new DumpError('The file ends in the middle of a statement')
  const tail = buf.slice(start, pos).trim()
  if (hasCode && tail) yield { sql: tail, line: firstLine }
}

/** Gives a Buffer stream back as latin1 strings. */
export async function* asLatin1(source: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  for await (const chunk of source) yield typeof chunk === 'string' ? chunk : chunk.toString('latin1')
}
