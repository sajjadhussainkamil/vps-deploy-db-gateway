/**
 * Coolify's backup files, as the gateway may read them. A path is accepted only when it sits in the
 * folder Coolify keeps for that one database, names a Postgres dump and is no link to anything else.
 */
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { forbidden, notFound } from './errors.js'

/** Where Coolify writes database dumps on the host, mounted at the same path in the gateway. */
export const BACKUP_ROOT = process.env.GATEWAY_BACKUP_ROOT || '/data/coolify/backups/databases'

const FILE_RE = /^pg-dump-[A-Za-z0-9_.-]+\.dmp$/

export interface BackupFile {
  path: string
  owner: string
}

/** The checked file and its size, or a refusal that says nothing about the disk. */
export async function assertBackupFile(file: BackupFile | undefined, root = BACKUP_ROOT): Promise<{ path: string; size: number }> {
  if (!file) throw forbidden('No backup file was named')
  const normal = path.posix.normalize(file.path)
  if (normal !== file.path || !normal.startsWith(`${root}/`)) throw forbidden('That backup file is not allowed')

  // <team folder>/<database name>-<uuid>/<dump>
  const parts = normal.slice(root.length + 1).split('/')
  if (parts.length !== 3 || !parts[1]?.endsWith(`-${file.owner}`) || !FILE_RE.test(parts[2] ?? '')) {
    throw forbidden('That backup file is not allowed')
  }

  let real: string
  try {
    real = await realpath(normal)
  } catch {
    throw notFound('That backup is no longer on the server')
  }
  if (real !== normal) throw forbidden('That backup file is not allowed')
  const info = await stat(real)
  if (!info.isFile()) throw notFound('That backup is no longer on the server')
  return { path: real, size: info.size }
}
