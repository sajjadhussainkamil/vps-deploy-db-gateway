/**
 * Replaces a MySQL database with a dump, statement by statement. There is no client binary here, so a
 * file can never run a shell command. MySQL cannot undo this, so the portal always holds a safety backup.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { GatewayError, notFound } from '../../errors.js'
import { dropUpload } from '../../uploads.js'
import type { Claims } from '../../token.js'
import { quoteAccount } from './bootstrap-sql.js'
import { driver, open, type Conn, type Login, type Rows } from './conn.js'
import { checkUploaded, rewriteDefiner } from './dump-policy.js'
import { asLatin1, readStatements } from './dump-reader.js'

export const RESTORE_MAX_MS = 30 * 60_000
const KEEP_MS = 60 * 60_000

interface Job {
  sub: string
  state: 'running' | 'done' | 'failed'
  error?: string
  /** The database was emptied, so a failure needs the safety backup. */
  emptied?: boolean
  startedAt: number
  endedAt?: number
}

const jobs = new Map<string, Job>()

function forget(now = Date.now()): void {
  for (const [id, job] of jobs) if (job.endedAt && now - job.endedAt > KEEP_MS) jobs.delete(id)
}

export function jobStatus(id: string, sub: string): { state: Job['state']; error?: string; emptied?: boolean; seconds: number } {
  const job = jobs.get(id)
  // Unlike PostgreSQL nothing rolls back on its own, so the portal treats this as emptied.
  if (!job || job.sub !== sub) throw notFound('That restore is not known here. The gateway may have restarted.')
  return { state: job.state, ...(job.error ? { error: job.error } : {}), ...(job.emptied ? { emptied: true } : {}), seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000) }
}

function assertIdle(sub: string): void {
  forget()
  for (const job of jobs.values()) {
    if (job.sub === sub && job.state === 'running') throw new GatewayError(409, 'restore_running', 'A restore is already running for this database')
  }
}

const GZIP = [0x1f, 0x8b]

/** The file's text, unpacked if needed and stopped at `maxBytes` so a small archive cannot fill the disk. */
async function* fileText(path: string, maxBytes: number): AsyncGenerator<string> {
  const head = await new Promise<Buffer>((resolve, reject) => {
    const s = createReadStream(path, { start: 0, end: 1 })
    const parts: Buffer[] = []
    s.on('data', (d) => parts.push(d as Buffer))
    s.on('error', reject)
    s.on('end', () => resolve(Buffer.concat(parts)))
  })
  const raw = createReadStream(path)
  const source: AsyncIterable<Buffer> = head[0] === GZIP[0] && head[1] === GZIP[1] ? pipeline(raw, createGunzip(), () => undefined) : raw
  let total = 0
  for await (const chunk of asLatin1(source)) {
    total += chunk.length
    if (total > maxBytes) throw new Error('This file unpacks to more than this database can hold')
    yield chunk
  }
}

async function databaseDefaults(root: Conn, db: string): Promise<{ charset: string; collation: string }> {
  const [rows] = await root.execute<Rows>('SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db])
  return { charset: String(rows[0]?.charset ?? 'utf8mb4'), collation: String(rows[0]?.collation ?? 'utf8mb4_0900_ai_ci') }
}

/** Lock the application out and end its sessions, leaving `keep` alone. */
async function lockOut(root: Conn, appUser: string, keep?: number): Promise<void> {
  await root.query(`ALTER USER ${quoteAccount(appUser)} ACCOUNT LOCK`)
  const [rows] = await root.execute<Rows>('SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = ?', [appUser])
  for (const r of rows) {
    const id = Number(r.id)
    if (id !== keep) await root.query(`KILL ${Math.trunc(id)}`).catch(() => undefined)
  }
}

const quoteDb = (db: string) => `\`${db.replace(/`/g, '``')}\``

async function recreate(root: Conn, db: string): Promise<void> {
  const { charset, collation } = await databaseDefaults(root, db)
  await root.query(`DROP DATABASE ${quoteDb(db)}`)
  await root.query(`CREATE DATABASE ${quoteDb(db)} CHARACTER SET ${charset} COLLATE ${collation}`)
}

const message = (e: unknown) => {
  const err = e as { sqlMessage?: string; message?: string }
  return (err.sqlMessage ?? err.message ?? 'The restore failed').slice(0, 300)
}

async function apply(c: Conn, db: string, file: string, maxBytes: number, transform: (sql: string) => string | null): Promise<void> {
  // Dropping the database left this connection with no current one.
  await c.query(`USE ${quoteDb(db)}`)
  for await (const { sql, line } of readStatements(fileText(file, maxBytes))) {
    const out = transform(sql)
    if (out === null) continue
    try {
      await c.query(out)
    } catch (e) {
      throw new Error(`Line ${line}: ${message(e)}`)
    }
  }
}

interface Started {
  claims: Claims
  address: string
  appUser: string
}

async function runServer(job: Job, s: Started, file: string): Promise<void> {
  const db = s.claims.target.db
  const root = await open(s.claims, s.address)
  // Binary mode passes the dump's bytes through; its own SET NAMES says how to read them.
  const load = await open(s.claims, s.address, undefined, 'binary')
  const timer = setTimeout(() => load.destroy(), RESTORE_MAX_MS)
  const account = quoteAccount(s.appUser)
  try {
    await lockOut(root, s.appUser)
    job.emptied = true
    await recreate(root, db)
    // A copy lands under another database's account, so every stored object is handed to this one.
    await apply(load, db, file, Number.MAX_SAFE_INTEGER, (sql) => rewriteDefiner(sql, account))
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = driver(load).stream.destroyed ? 'The restore took longer than 30 minutes and was stopped' : message(e)
  } finally {
    clearTimeout(timer)
    job.endedAt = Date.now()
    load.destroy()
    await root.query(`ALTER USER ${account} ACCOUNT UNLOCK`).catch(() => undefined)
    root.destroy()
  }
}

/** First pass over a customer's file. Nothing has changed yet, so a refusal costs nothing. */
async function vetUpload(db: string, file: string, maxBytes: number): Promise<void> {
  for await (const { sql, line } of readStatements(fileText(file, maxBytes))) {
    const verdict = checkUploaded(sql, db)
    if (verdict.action === 'refuse') throw new Error(`This file contains something we cannot restore (line ${line}: ${verdict.reason}). Remove it and try again.`)
  }
}

async function runUpload(job: Job, s: Started, app: Login, file: string, uploadId: string, maxBytes: number): Promise<void> {
  const db = s.claims.target.db
  let root: Conn | null = null
  let load: Conn | null = null
  let wasLocked = false
  const account = quoteAccount(app.user)
  const timer = setTimeout(() => load?.destroy(), RESTORE_MAX_MS)
  try {
    await vetUpload(db, file, maxBytes)
    root = await open(s.claims, s.address)
    // Opened before the lockout, because a locked account cannot log in but keeps what it has.
    load = await open(s.claims, s.address, app, 'binary')
    const [rows] = await root.query<Rows>('SELECT @@global.read_only AS ro')
    wasLocked = Number(rows[0]?.ro) === 1
    if (wasLocked) await root.query('SET GLOBAL read_only = OFF')
    await lockOut(root, app.user, load.threadId)
    job.emptied = true
    await recreate(root, db)
    await apply(load, db, file, maxBytes, (sql) => {
      const verdict = checkUploaded(sql, db)
      if (verdict.action === 'refuse') throw new Error(verdict.reason)
      return verdict.action === 'skip' ? null : rewriteDefiner(sql, null)
    })
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = load && driver(load).stream.destroyed ? 'The restore took longer than 30 minutes and was stopped' : message(e)
  } finally {
    clearTimeout(timer)
    job.endedAt = Date.now()
    load?.destroy()
    if (root) {
      if (wasLocked) await root.query('SET GLOBAL read_only = ON').catch(() => undefined)
      await root.query(`ALTER USER ${account} ACCOUNT UNLOCK`).catch(() => undefined)
      root.destroy()
    }
    await dropUpload(uploadId)
  }
}

function begin(sub: string): { id: string; job: Job } {
  assertIdle(sub)
  const id = randomBytes(12).toString('hex')
  const job: Job = { sub, state: 'running', startedAt: Date.now() }
  jobs.set(id, job)
  return { id, job }
}

export function startRestore(claims: Claims, address: string, file: string, appUser: string): { job: string } {
  const { id, job } = begin(claims.sub)
  void runServer(job, { claims, address, appUser }, file)
  return { job: id }
}

export function startUploadRestore(claims: Claims, address: string, app: Login, file: string, uploadId: string, maxBytes: number): { job: string } {
  const { id, job } = begin(claims.sub)
  void runUpload(job, { claims, address, appUser: app.user }, app, file, uploadId, maxBytes)
  return { job: id }
}
