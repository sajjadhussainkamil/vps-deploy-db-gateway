/** Which operations each database engine has. A token names its engine; the default is PostgreSQL. */
import { OPS as POSTGRES_OPS } from '../ops/index.js'
import type { Op } from '../ops/types.js'
import { accountUnlock, applyLimits, bootstrap, lock, optimize, unlock } from './mysql/ops/admin.js'
import { execute, query } from './mysql/ops/console.js'
import { insert, remove, rows, update } from './mysql/ops/data.js'
import { ddl } from './mysql/ops/ddl.js'
import { importRows } from './mysql/ops/import.js'
import { health, schema, stats } from './mysql/ops/inspect.js'
import { restore, restoreStatus, restoreUpload } from './mysql/ops/restore.js'

export const MYSQL_OPS: Record<string, Op> = {
  health,
  schema,
  stats,
  rows,
  insert,
  update,
  delete: remove,
  bootstrap,
  lock,
  unlock,
  query,
  execute,
  ddl,
  import: importRows,
  restore,
  restore_status: restoreStatus,
  restore_upload: restoreUpload,
  apply_limits: applyLimits,
  account_unlock: accountUnlock,
  optimize,
}

export type Engine = 'postgresql' | 'mysql'

export const opsFor = (engine: Engine): Record<string, Op> => (engine === 'mysql' ? MYSQL_OPS : POSTGRES_OPS)

export const ALL_OPS: ReadonlySet<string> = new Set([...Object.keys(POSTGRES_OPS), ...Object.keys(MYSQL_OPS)])
