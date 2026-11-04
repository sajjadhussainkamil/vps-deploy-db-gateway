import { bootstrap, lock, unlock, vacuum } from './admin.js'
import { insert, remove, rows, update } from './data.js'
import { execute, query } from './console.js'
import { ddl } from './ddl.js'
import { extension } from './extension.js'
import { importRows } from './import.js'
import { health, schema, stats } from './inspect.js'
import type { Op } from './types.js'

/** Every operation the gateway will run. A token naming anything else is refused before it is read further. */
export const OPS: Record<string, Op> = {
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
  vacuum,
  query,
  execute,
  ddl,
  import: importRows,
  extension,
}

export const ALLOWED_OPS: ReadonlySet<string> = new Set(Object.keys(OPS))
