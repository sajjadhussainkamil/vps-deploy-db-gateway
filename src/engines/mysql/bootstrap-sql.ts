/**
 * The accounts a MySQL database needs, as SQL. Pure, so the quoting is tested against hostile input.
 * The gateway and the portal carry the same file; a test keeps them identical.
 */
export const quoteLiteral = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
export const quoteAccount = (user: string) => `${quoteLiteral(user)}@'%'`

/** A GRANT treats _ and % in a database name as wildcards, so they are escaped. */
export const grantDatabase = (db: string) => `\`${db.replace(/`/g, '``').replace(/([\\_%])/g, '\\$1')}\``

const ON_DATABASE = 'SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER'

export interface MysqlBootstrapInput {
  dbName: string
  appUser: string
  appPassword: string
  maintUser: string
  maintPassword: string
  maxUserConnections: number
}

/** Safe to run again: the same statements set a rotated password and put the rights back. */
export function mysqlBootstrapStatements(i: MysqlBootstrapInput): string[] {
  const app = quoteAccount(i.appUser)
  const maint = quoteAccount(i.maintUser)
  const appPw = quoteLiteral(i.appPassword)
  const maintPw = quoteLiteral(i.maintPassword)
  const db = grantDatabase(i.dbName)
  return [
    `CREATE USER IF NOT EXISTS ${app} IDENTIFIED BY ${appPw}`,
    `ALTER USER ${app} IDENTIFIED BY ${appPw} WITH MAX_USER_CONNECTIONS ${Math.trunc(i.maxUserConnections)} ACCOUNT UNLOCK`,
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${app}`,
    `GRANT ${ON_DATABASE} ON ${db}.* TO ${app}`,
    `CREATE USER IF NOT EXISTS ${maint} IDENTIFIED BY ${maintPw}`,
    `ALTER USER ${maint} IDENTIFIED BY ${maintPw} ACCOUNT UNLOCK`,
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${maint}`,
    `GRANT ${ON_DATABASE} ON ${db}.* TO ${maint}`,
    // Passes the read-only lock in recovery mode, and is the only global right this account holds.
    `GRANT CONNECTION_ADMIN ON *.* TO ${maint}`,
  ]
}
