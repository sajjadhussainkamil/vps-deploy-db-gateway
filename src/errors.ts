/** Errors the gateway answers with. Database errors pass through: they describe the customer's own data. */

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { hint?: string; detail?: string; position?: string; constraint?: string } = {}
  ) {
    super(message)
  }
}

export const badRequest = (message: string) => new GatewayError(400, 'bad_request', message)
export const forbidden = (message: string) => new GatewayError(403, 'forbidden', message)
export const notFound = (message: string) => new GatewayError(404, 'not_found', message)

export interface WireError {
  code: string
  message: string
  hint?: string
  detail?: string
  position?: string
  constraint?: string
  /** Which statement of a script failed, counting from zero. */
  statement?: number
}

interface PgLike {
  code?: string
  message?: string
  hint?: string
  detail?: string
  position?: string
  constraint_name?: string
  statementIndex?: number
}

interface MysqlLike {
  errno?: number
  sqlState?: string
  sqlMessage?: string
  statementIndex?: number
}

const MYSQL_LOGIN_REFUSED = new Set([1044, 1045, 1251, 3118, 3159])
const MYSQL_READ_ONLY = 1290
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'CONNECT_TIMEOUT', 'ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST'])

/** Turn anything thrown into the envelope the portal reads. Never includes a connection target. */
export function toWire(err: unknown): { status: number; error: WireError } {
  if (err instanceof GatewayError) {
    return { status: err.status, error: { code: err.code, message: err.message, ...err.extra } }
  }
  const my = err as MysqlLike
  if (typeof my?.errno === 'number' && typeof my.sqlState === 'string') {
    // A refused login names the internal host, so it never travels.
    if (MYSQL_LOGIN_REFUSED.has(my.errno)) return { status: 502, error: { code: 'unreachable', message: 'Could not reach the database' } }
    const message = my.errno === MYSQL_READ_ONLY ? 'This database is locked because it is over its size limit' : my.sqlMessage ?? 'Database error'
    return { status: 400, error: { code: my.sqlState, message, ...(typeof my.statementIndex === 'number' ? { statement: my.statementIndex } : {}) } }
  }
  const pg = err as PgLike
  // A five-character SQLSTATE means Postgres itself answered.
  if (typeof pg?.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
    return {
      status: 400,
      error: {
        code: pg.code,
        message: pg.message ?? 'Database error',
        ...(pg.hint ? { hint: pg.hint } : {}),
        ...(pg.detail ? { detail: pg.detail } : {}),
        ...(pg.position ? { position: pg.position } : {}),
        ...(pg.constraint_name ? { constraint: pg.constraint_name } : {}),
        ...(typeof pg.statementIndex === 'number' ? { statement: pg.statementIndex } : {}),
      },
    }
  }
  const code = (err as { code?: string })?.code
  if (code && NETWORK_CODES.has(code)) {
    return { status: 502, error: { code: 'unreachable', message: 'Could not reach the database' } }
  }
  return { status: 500, error: { code: 'internal', message: 'Something went wrong in the gateway' } }
}
