/**
 * Dump files sent in by a customer, kept in the gateway's own temporary folder until their restore
 * ends. Only PostgreSQL custom-format dumps are taken, and each belongs to the one database it was sent for.
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GatewayError, notFound } from './errors.js'

export const UPLOAD_ROOT = process.env.GATEWAY_UPLOAD_ROOT || path.join(tmpdir(), 'gateway-uploads')
const KEEP_MS = 2 * 60 * 60_000
/** Disk left for the databases on the same server once a file has arrived. */
export const SPARE_BYTES = 2 * 2 ** 30
/** Files arriving at the same time; each can be gigabytes. */
export const MAX_UPLOADS = 2
let receiving = 0
/** What pg_dump --format=custom writes first. */
export const DUMP_MAGIC = Buffer.from('PGDMP')

interface Upload {
  sub: string
  path: string
  size: number
  at: number
}

const uploads = new Map<string, Upload>()

async function forget(now = Date.now()): Promise<void> {
  for (const [id, u] of uploads) {
    if (now - u.at > KEEP_MS) {
      uploads.delete(id)
      await rm(u.path, { force: true }).catch(() => undefined)
    }
  }
}

// Files whose restore never started are gone within two hours, even with no new upload.
setInterval(() => void forget(), 10 * 60_000).unref()

/** Free bytes where uploads are kept. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Refuses a file the disk cannot hold with room to spare, before a byte is written. */
export function assertRoom(free: number, bytes: number | undefined): void {
  if (free - (bytes ?? 0) < SPARE_BYTES) {
    throw new GatewayError(507, 'too_large', 'The server does not have enough free disk for this file right now. Try again later or contact support.')
  }
}

/** Counts and checks the bytes on their way to disk, so a wrong or oversized file stops early. */
export function dumpGuard(maxBytes: number): Transform & { bytes: () => number } {
  let size = 0
  let head = Buffer.alloc(0)
  const guard = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > maxBytes) return done(new GatewayError(413, 'too_large', `The file is larger than this database's ${Math.floor(maxBytes / 2 ** 20)} MB limit`))
      if (head.length < DUMP_MAGIC.length) {
        head = Buffer.concat([head, chunk]).subarray(0, DUMP_MAGIC.length)
        if (head.length === DUMP_MAGIC.length && !head.equals(DUMP_MAGIC)) {
          return done(new GatewayError(400, 'bad_request', 'This is not a PostgreSQL backup file. Use a .dump file downloaded from Backups, or one made with pg_dump --format=custom.'))
        }
      }
      done(null, chunk)
    },
    flush(done) {
      if (head.length < DUMP_MAGIC.length) return done(new GatewayError(400, 'bad_request', 'The file is empty or too short to be a PostgreSQL backup'))
      done()
    },
  })
  return Object.assign(guard, { bytes: () => size })
}

/** Writes the request body to disk and answers with the id the restore asks for. */
export async function receiveUpload(body: Readable, sub: string, maxBytes: number, bytes?: number): Promise<{ upload: string; size: number }> {
  if (receiving >= MAX_UPLOADS) throw new GatewayError(503, 'busy', 'Another file is being received. Try again in a few minutes.')
  receiving++
  try {
    return await receive(body, sub, maxBytes, bytes)
  } finally {
    receiving--
  }
}

async function receive(body: Readable, sub: string, maxBytes: number, bytes?: number): Promise<{ upload: string; size: number }> {
  await forget()
  await mkdir(UPLOAD_ROOT, { recursive: true, mode: 0o700 })
  assertRoom(await freeBytes(UPLOAD_ROOT), bytes)
  const id = randomBytes(12).toString('hex')
  const file = path.join(UPLOAD_ROOT, `${id}.dump`)
  // A declared size is a promise: more than that is refused as well.
  const guard = dumpGuard(bytes ? Math.min(maxBytes, bytes) : maxBytes)
  try {
    // The request stays out of the pipeline, so a refusal can still be answered on it.
    const writing = pipeline(guard, createWriteStream(file, { mode: 0o600 }))
    body.on('close', () => {
      if (!body.readableEnded) guard.destroy(new GatewayError(400, 'bad_request', 'The upload stopped before it finished. Try again.'))
    })
    body.on('error', () => guard.destroy(new GatewayError(400, 'bad_request', 'The upload stopped before it finished. Try again.')))
    body.pipe(guard)
    await writing
  } catch (e) {
    await rm(file, { force: true }).catch(() => undefined)
    if (e instanceof GatewayError) throw e
    throw new GatewayError(400, 'bad_request', 'The upload stopped before it finished. Try again.')
  }
  const size = guard.bytes()
  uploads.set(id, { sub, path: file, size, at: Date.now() })
  return { upload: id, size }
}

/** The file sent for this database, or a refusal that says to send it again. */
export function uploadedFile(id: string, sub: string): string {
  const u = uploads.get(id)
  if (!u || u.sub !== sub) throw notFound('The uploaded file is no longer on the server. Upload it again.')
  return u.path
}

export async function dropUpload(id: string): Promise<void> {
  const u = uploads.get(id)
  uploads.delete(id)
  if (u) await rm(u.path, { force: true }).catch(() => undefined)
}
