/**
 * Where the gateway may connect. The token names the database, so a stolen or forged token must
 * never be able to point the gateway at anything else: only Coolify database containers, only
 * Postgres' port, only addresses on the private network.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { forbidden } from './errors.js'
import type { Target } from './token.js'

/** Coolify names a database container by its 24-character resource uuid. */
const HOST_RE = /^[a-z0-9]{24}$/
export const POSTGRES_PORT = 5432

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  if (!base || isIP(base) !== 4 || isIP(ip) !== 4) return false
  const bits = Number(bitsRaw ?? 32)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask)
}

const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((c) => inCidr(ip, c))
  // Docker networks may be IPv6 unique-local; nothing public, loopback or link-local qualifies.
  return /^f[cd][0-9a-f]{2}:/i.test(ip)
}

export interface TargetPolicy {
  /** Optional narrower range, e.g. the destination network's subnet. */
  allowedCidr?: string
  resolve?: (host: string) => Promise<string[]>
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((r) => r.address)

/**
 * Throws unless the target is a database container on the private network. No connection is made
 * first. Returns the checked address, which is what the connection must use.
 */
export async function assertTargetAllowed(target: Target, policy: TargetPolicy = {}): Promise<string> {
  if (!HOST_RE.test(target.host)) throw forbidden('That database address is not allowed')
  if (target.port !== POSTGRES_PORT) throw forbidden('That database port is not allowed')

  let addresses: string[]
  try {
    addresses = await (policy.resolve ?? defaultResolve)(target.host)
  } catch {
    throw forbidden('That database address is not allowed')
  }
  if (addresses.length === 0) throw forbidden('That database address is not allowed')
  for (const ip of addresses) {
    if (!isPrivateAddress(ip)) throw forbidden('That database address is not allowed')
    if (policy.allowedCidr && !inCidr(ip, policy.allowedCidr)) throw forbidden('That database address is not allowed')
  }
  return addresses[0] as string
}
