/**
 * Putting a Coolify dump back into a database, as one transaction: if any statement fails nothing
 * changes. Schemas and extensions are made as the admin role, everything else as the app role, so
 * the application owns its tables again and its own migrations keep working. An uploaded file is
 * not trusted that far and takes runUpload instead.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isAllowedExtension, quoteIdent } from './bootstrap-sql.js'
import { GatewayError, notFound } from './errors.js'
import { dropUpload } from './uploads.js'

export const RESTORE_MAX_MS = 30 * 60_000
const KEEP_MS = 60 * 60_000
const TOC_MAX_BYTES = 20 * 1024 * 1024

export interface TocSplit {
  /** Schemas and extensions: made by the admin role. */
  admin: string[]
  /** Everything else, made by the app role. */
  rest: string[]
  /** Non-public schemas the dump creates, handed to the app role once made. */
  schemas: string[]
}

const SCHEMA_RE = /^\d+; \d+ \d+ SCHEMA \S+ (\S+)/
const EXTENSION_RE = /^\d+; \d+ \d+ EXTENSION \S+ \S+/
const EXTENSION_COMMENT_RE = /^\d+; \d+ \d+ COMMENT \S+ EXTENSION \S+/

/** Splits `pg_restore -l` output into what each role restores. Comment lines are dropped. */
export function splitToc(toc: string): TocSplit {
  const out: TocSplit = { admin: [], rest: [], schemas: [] }
  for (const line of toc.split('\n')) {
    if (!line.trim() || line.startsWith(';')) continue
    const schema = SCHEMA_RE.exec(line)
    if (schema) {
      // public is made fresh before the restore, so the dump's own entry is skipped.
      if (schema[1] === 'public') continue
      out.admin.push(line)
      out.schemas.push(schema[1] as string)
    } else if (EXTENSION_RE.test(line) || EXTENSION_COMMENT_RE.test(line)) {
      out.admin.push(line)
    } else {
      out.rest.push(line)
    }
  }
  return out
}

/** Empties the database: every user schema goes, public comes back empty. */
export const PRELUDE = `SET lock_timeout = '30s';
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', s.nspname);
  END LOOP;
END $$;
CREATE SCHEMA public AUTHORIZATION pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;
`

export function middle(schemas: string[], appUser: string): string {
  const role = quoteIdent(appUser)
  return `${schemas.map((s) => `ALTER SCHEMA ${quoteIdent(s)} OWNER TO ${role};`).join('\n')}\nSET ROLE ${role};\n`
}

export function closing(dbName: string, appUser: string): string {
  const role = quoteIdent(appUser)
  return `RESET ROLE;\nALTER DATABASE ${quoteIdent(dbName)} OWNER TO ${role};\nGRANT ALL ON SCHEMA public TO ${role};\n`
}

interface Job {
  sub: string
  state: 'running' | 'done' | 'failed'
  error?: string
  /** An upload restore got past emptying the database, so a failure needs the safety backup. */
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
  if (!job || job.sub !== sub) throw notFound('That restore is not known here. The gateway may have restarted; nothing was changed.')
  return { state: job.state, ...(job.error ? { error: job.error } : {}), ...(job.emptied ? { emptied: true } : {}), seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000) }
}

/** The first Postgres error line, without anything about the connection. */
export function firstError(stderr: string): string {
  const line = stderr.split('\n').find((l) => /ERROR:/.test(l)) ?? stderr.split('\n').find((l) => l.trim())
  return (line ?? 'The restore failed').replace(/^.*?ERROR:\s*/, '').slice(0, 300)
}

function collect(child: ReturnType<typeof spawn>, max: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < max) out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 8192) err += c.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

/** Streams one pg_restore's SQL into psql's stdin, leaving stdin open for what follows. */
function pipeInto(file: string, list: string, stdin: NodeJS.WritableStream, live: Set<ChildProcess>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_restore', ['--no-owner', '--no-acl', '-L', list, '-f', '-', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    live.add(child)
    child.on('close', () => live.delete(child))
    let err = ''
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4096) err += c.toString('utf8')
    })
    child.stdout.pipe(stdin, { end: false })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(firstError(err) || 'Could not read the backup file'))))
  })
}

export interface RestoreTarget {
  address: string
  port: number
  db: string
  user: string
  password: string
}

async function run(job: Job, target: RestoreTarget, file: string, appUser: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'restore-'))
  const kill: (() => void)[] = []
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill.forEach((k) => k())
  }, RESTORE_MAX_MS)
  try {
    const toc = await collect(spawn('pg_restore', ['-l', file], { stdio: ['ignore', 'pipe', 'pipe'] }), TOC_MAX_BYTES)
    if (toc.code !== 0) throw new Error(firstError(toc.err) || 'Could not read the backup file')
    const split = splitToc(toc.out)
    const adminList = path.join(dir, 'admin.list')
    const restList = path.join(dir, 'rest.list')
    await writeFile(adminList, `${split.admin.join('\n')}\n`)
    await writeFile(restList, `${split.rest.join('\n')}\n`)

    // A locked database must still take its own restore, so the session starts read-write.
    const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      // Only what psql needs: the gateway's own secret never reaches a child process.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PGHOST: target.address,
        PGPORT: String(target.port),
        PGDATABASE: target.db,
        PGUSER: target.user,
        PGPASSWORD: target.password,
        PGAPPNAME: 'platform-gateway-restore',
        PGOPTIONS: '-c default_transaction_read_only=off -c statement_timeout=0',
      } as unknown as NodeJS.ProcessEnv,
    })
    const live = new Set<ChildProcess>()
    kill.push(() => psql.kill('SIGKILL'))
    const done = collect(psql, 0)
    // psql stops at the first error; whatever is still feeding it has nowhere to go.
    psql.on('close', () => live.forEach((c) => c.kill('SIGKILL')))
    psql.stdin.on('error', () => undefined)
    let feedError: unknown = null
    try {
      psql.stdin.write(PRELUDE)
      if (split.admin.length) await pipeInto(file, adminList, psql.stdin, live)
      psql.stdin.write(middle(split.schemas, appUser))
      await pipeInto(file, restList, psql.stdin, live)
      psql.stdin.write(closing(target.db, appUser))
    } catch (e) {
      feedError = e
      // Ending the input would commit half a restore; killing psql makes Postgres roll it back.
      psql.kill('SIGKILL')
    }
    psql.stdin.end()
    const result = await done
    // psql's own failure explains more than the reader it cut off.
    if (result.code !== null && result.code !== 0) throw new Error(firstError(result.err))
    if (feedError) throw feedError instanceof Error ? feedError : new Error('Could not read the backup file')
    if (result.code !== 0) throw new Error('The restore was stopped before it finished')
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = timedOut ? 'The restore took longer than 30 minutes and was undone' : e instanceof Error ? e.message.slice(0, 300) : 'The restore failed'
  } finally {
    clearTimeout(timer)
    job.endedAt = Date.now()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const EXTENSION_NAME_RE = /^\d+; \d+ \d+ EXTENSION \S+ (\S+)/

export interface UploadPlan {
  /** Allow-listed extensions, made by our own SQL, never the file's. */
  extensions: string[]
  /** Everything else, restored as the app role. */
  rest: string[]
}

/** A file from outside is trusted with nothing: its extensions must be on the allow-list, the rest runs as app. */
export function planUpload(toc: string, allowed: (name: string) => boolean): UploadPlan {
  const out: UploadPlan = { extensions: [], rest: [] }
  for (const line of toc.split('\n')) {
    if (!line.trim() || line.startsWith(';')) continue
    const ext = EXTENSION_NAME_RE.exec(line)
    if (ext) {
      const name = ext[1] as string
      if (!allowed(name)) throw new GatewayError(400, 'bad_request', `This backup needs the ${name} extension, which is not available here`)
      out.extensions.push(name)
      continue
    }
    if (EXTENSION_COMMENT_RE.test(line)) continue
    const schema = SCHEMA_RE.exec(line)
    if (schema && schema[1] === 'public') continue
    out.rest.push(line)
  }
  return out
}

export interface AppLogin {
  user: string
  password: string
}

const pgEnv = (target: RestoreTarget, login: AppLogin) =>
  ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    PGHOST: target.address,
    PGPORT: String(target.port),
    PGDATABASE: target.db,
    PGUSER: login.user,
    PGPASSWORD: login.password,
    PGAPPNAME: 'platform-gateway-restore',
    PGOPTIONS: '-c default_transaction_read_only=off -c statement_timeout=0',
  }) as unknown as NodeJS.ProcessEnv

/** Runs SQL we wrote ourselves; nothing from the file ever goes through psql. */
async function runSql(target: RestoreTarget, login: AppLogin, sql: string, kill: (() => void)[]): Promise<void> {
  const psql = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'], env: pgEnv(target, login) })
  kill.push(() => psql.kill('SIGKILL'))
  const done = collect(psql, 0)
  psql.stdin.on('error', () => undefined)
  psql.stdin.end(sql)
  const result = await done
  if (result.code !== 0) throw new Error(firstError(result.err))
}

/**
 * The file's own SQL runs through pg_restore connected as the app role: no psql to obey backslash
 * commands, and no superuser session it could switch back to.
 */
async function runUpload(job: Job, target: RestoreTarget, app: AppLogin, file: string, uploadId: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'restore-'))
  const kill: (() => void)[] = []
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill.forEach((k) => k())
  }, RESTORE_MAX_MS)
  const admin = { user: target.user, password: target.password }
  try {
    const toc = await collect(spawn('pg_restore', ['-l', file], { stdio: ['ignore', 'pipe', 'pipe'] }), TOC_MAX_BYTES)
    if (toc.code !== 0) throw new Error(`This file could not be read as a PostgreSQL backup: ${firstError(toc.err)}`)
    const plan = planUpload(toc.out, isAllowedExtension)
    const list = path.join(dir, 'rest.list')
    await writeFile(list, `${plan.rest.join('\n')}\n`)

    if (plan.extensions.length) await runSql(target, admin, plan.extensions.map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e)};`).join('\n'), kill)
    // Everything the app role owns goes; extensions and the public schema stay.
    job.emptied = true
    await runSql(target, app, `SET lock_timeout = '30s';\nDROP OWNED BY CURRENT_USER;\n`, kill)

    const restore = spawn('pg_restore', ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', '-L', list, '-d', target.db, file], { stdio: ['ignore', 'ignore', 'pipe'], env: pgEnv(target, app) })
    kill.push(() => restore.kill('SIGKILL'))
    const result = await collect(restore, 0)
    if (result.code !== 0) throw new Error(firstError(result.err))

    await runSql(target, admin, `GRANT ALL ON DATABASE ${quoteIdent(target.db)} TO ${quoteIdent(app.user)};\nGRANT ALL ON SCHEMA public TO ${quoteIdent(app.user)};\n`, kill)
    job.state = 'done'
  } catch (e) {
    job.state = 'failed'
    job.error = timedOut ? 'The restore took longer than 30 minutes and was stopped' : e instanceof Error ? e.message.slice(0, 300) : 'The restore failed'
  } finally {
    clearTimeout(timer)
    job.endedAt = Date.now()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    await dropUpload(uploadId)
  }
}

/** Starts restoring an uploaded file and answers at once, like startRestore. */
export function startUploadRestore(sub: string, target: RestoreTarget, app: AppLogin, file: string, uploadId: string): { job: string } {
  forget()
  for (const job of jobs.values()) {
    if (job.sub === sub && job.state === 'running') throw new GatewayError(409, 'restore_running', 'A restore is already running for this database')
  }
  const id = randomBytes(12).toString('hex')
  const job: Job = { sub, state: 'running', startedAt: Date.now() }
  jobs.set(id, job)
  void runUpload(job, target, app, file, uploadId)
  return { job: id }
}

/** Starts the restore and answers at once; the portal asks for the outcome with jobStatus. */
export function startRestore(sub: string, target: RestoreTarget, file: string, appUser: string): { job: string } {
  forget()
  for (const job of jobs.values()) {
    if (job.sub === sub && job.state === 'running') throw new GatewayError(409, 'restore_running', 'A restore is already running for this database')
  }
  const id = randomBytes(12).toString('hex')
  const job: Job = { sub, state: 'running', startedAt: Date.now() }
  jobs.set(id, job)
  void run(job, target, file, appUser)
  return { job: id }
}
