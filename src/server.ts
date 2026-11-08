/** The gateway's HTTP face: /healthz, /op, /batch and /download. All the real work is in handle.ts. */
import { constants, createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import { BACKUP_ROOT } from './backup-files.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { handle, verifyDownload, verifyUpload, type HandlerConfig } from './handle.js'
import { toWire } from './errors.js'
import { receiveUpload } from './uploads.js'

/** Raised when the gateway learns something the portal must check for before offering it. */
export const GATEWAY_VERSION = 5
const FEATURES = ['restore', 'download', 'upload']

/** Restore and download need Coolify's backups folder mounted and readable. */
async function backupsReadable(): Promise<boolean> {
  try {
    await access(BACKUP_ROOT, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Room for a CSV import; most requests are tiny.
const MAX_BODY = 8 * 1024 * 1024
const MAX_BATCH = 20
const MAX_CONCURRENT = 16
// Downloads stream for minutes; a few at once keeps the box responsive.
const MAX_DOWNLOADS = 4

function readConfig(): HandlerConfig & { port: number } {
  const secret = process.env.GATEWAY_JWT_SECRET ?? ''
  const audience = process.env.GATEWAY_AUDIENCE ?? ''
  if (secret.length < 32) throw new Error('GATEWAY_JWT_SECRET must be at least 32 characters')
  if (!audience) throw new Error('GATEWAY_AUDIENCE is required')
  return {
    secret,
    audience,
    port: Number(process.env.PORT ?? 8080),
    policy: { allowedCidr: process.env.GATEWAY_ALLOWED_CIDR || undefined },
    log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 })
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')

function main(): void {
  const cfg = readConfig()
  let active = 0
  let downloading = 0

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        const backups = await backupsReadable()
        return send(res, 200, { ok: true, version: GATEWAY_VERSION, backups, features: backups ? FEATURES : [] })
      }
      if (req.method === 'POST' && req.url === '/download') {
        if (downloading >= MAX_DOWNLOADS) return send(res, 503, { ok: false, error: { code: 'busy', message: 'The gateway is busy, try again' } })
        const file = await verifyDownload(bearer(req), cfg)
        if (!file.ok) return send(res, file.status, { ok: false, error: file.error })
        downloading++
        res.on('close', () => downloading--)
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size, 'cache-control': 'no-store' })
        const stream = createReadStream(file.path)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
      }
      if (req.method === 'POST' && req.url === '/upload') {
        const auth = verifyUpload(bearer(req), cfg)
        if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error })
        try {
          const out = await receiveUpload(req, auth.sub, auth.maxBytes, auth.bytes)
          cfg.log?.({ ts: new Date().toISOString(), op: 'upload', dbId: auth.sub, bytes: out.size, ok: true })
          return send(res, 200, { ok: true, data: out })
        } catch (err) {
          const wire = toWire(err)
          // The rest of a refused body is not read, so the connection closes after the answer.
          res.setHeader('connection', 'close')
          return send(res, wire.status, { ok: false, error: wire.error })
        }
      }
      if (req.method !== 'POST' || (req.url !== '/op' && req.url !== '/batch')) return send(res, 404, { ok: false, error: { code: 'not_found', message: 'Not found' } })

      // A small cap keeps one busy portal from queueing the box into the ground.
      if (active >= MAX_CONCURRENT) return send(res, 503, { ok: false, error: { code: 'busy', message: 'The gateway is busy, try again' } })
      active++
      try {
        if (req.url === '/op') {
          const out = await handle(bearer(req), await readJson(req), cfg)
          return out.ok ? send(res, 200, { ok: true, data: out.data }) : send(res, out.status, { ok: false, error: out.error })
        }

        // A batch is one sweep measuring a server's databases: tokens carry their own input-free ops.
        const body = (await readJson(req)) as { items?: { token: string; input?: unknown }[] }
        const items = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH) : []
        const results = await Promise.all(
          items.map(async (item) => {
            const out = await handle(String(item.token ?? ''), item.input, cfg)
            return out.ok ? { sub: out.sub, ok: true, data: out.data } : { sub: out.sub ?? null, ok: false, error: out.error }
          })
        )
        return send(res, 200, { ok: true, results })
      } finally {
        active--
      }
    } catch (err) {
      const status = (err as { status?: number }).status === 413 ? 413 : 400
      send(res, status, { ok: false, error: { code: 'bad_request', message: 'Could not read the request' } })
    }
  })
  server.headersTimeout = 10_000
  // Long enough for a large backup file to arrive; /op bodies are capped at 8 MB anyway.
  server.requestTimeout = 30 * 60_000
  server.listen(cfg.port, () => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg: 'db-gateway listening', port: cfg.port })}\n`))

  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main()
