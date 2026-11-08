/** The gateway's HTTP face: /healthz, /op, /batch and /download. All the real work is in handle.ts. */
import { createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { handle, verifyDownload, type HandlerConfig } from './handle.js'

/** Raised when the gateway learns something the portal must check for before offering it. */
export const GATEWAY_VERSION = 2
const FEATURES = ['restore', 'download']

// Room for a CSV import; most requests are tiny.
const MAX_BODY = 8 * 1024 * 1024
const MAX_BATCH = 20
const MAX_CONCURRENT = 16

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

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, version: GATEWAY_VERSION, features: FEATURES })
      if (req.method === 'POST' && req.url === '/download') {
        const file = await verifyDownload(bearer(req), cfg)
        if (!file.ok) return send(res, file.status, { ok: false, error: file.error })
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size, 'cache-control': 'no-store' })
        const stream = createReadStream(file.path)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
        return
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
  server.requestTimeout = 150_000
  server.listen(cfg.port, () => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg: 'db-gateway listening', port: cfg.port })}\n`))

  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main()
