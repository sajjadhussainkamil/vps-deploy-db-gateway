/**
 * The SQL that gives a fresh database its non-superuser `app` role. Kept identical to the
 * portal's lib/databases/bootstrap-sql.ts; a test compares the two so they cannot drift.
 */
const ALLOWED_EXTENSIONS = [
  'pgcrypto',
  'uuid-ossp',
  'pg_trgm',
  'citext',
  'hstore',
  'unaccent',
  'btree_gin',
  'btree_gist',
  'pg_stat_statements',
  'vector',
]

export const isAllowedExtension = (name: string) => ALLOWED_EXTENSIONS.includes(name)
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
export const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

export interface BootstrapInput {
  dbName: string
  appUser: string
  appPassword: string
  extensions: string[]
}

export interface BootstrapPlan {
  roleExists: string
  createRole: string
  alterRole: string
  after: string[]
}

export function bootstrapPlan(i: BootstrapInput): BootstrapPlan {
  const role = quoteIdent(i.appUser)
  const db = quoteIdent(i.dbName)
  const pw = quoteLiteral(i.appPassword)
  const base = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'

  return {
    roleExists: `SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(i.appUser)}`,
    createRole: `CREATE ROLE ${role} ${base} PASSWORD ${pw}`,
    alterRole: `ALTER ROLE ${role} ${base} PASSWORD ${pw}`,
    after: [
      `ALTER ROLE ${role} SET statement_timeout = '60s'`,
      `ALTER ROLE ${role} SET lock_timeout = '10s'`,
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '60s'`,
      `ALTER DATABASE ${db} OWNER TO ${role}`,
      `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`,
      `GRANT ALL ON DATABASE ${db} TO ${role}`,
      `GRANT ALL ON SCHEMA public TO ${role}`,
      // Only allow-listed extensions are ever created.
      ...i.extensions.filter(isAllowedExtension).map((e) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(e)}`),
    ],
  }
}
