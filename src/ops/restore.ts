/** Restoring a database from one of its own Coolify backups, or a copy from another's. */
import { z } from 'zod'
import { assertBackupFile } from '../backup-files.js'
import { jobStatus, startRestore, startUploadRestore } from '../restore.js'
import { forbidden } from '../errors.js'
import { uploadedFile } from '../uploads.js'
import type { Op } from './types.js'

const restoreInput = z.object({ appUser: z.string().min(1).max(63) })

export const restore: Op = {
  mode: 'admin',
  input: restoreInput,
  async run({ claims, address, input }) {
    const { appUser } = restoreInput.parse(input)
    const file = await assertBackupFile(claims.file)
    const t = claims.target
    return startRestore(claims.sub, { address, port: t.port, db: t.db, user: t.user, password: t.password }, file.path, appUser)
  },
}

const uploadInput = z.object({ upload: z.string().regex(/^[a-f0-9]{24}$/) })

/** Restores a file the customer sent in, connected as the app role (see runUpload). */
export const restoreUpload: Op = {
  mode: 'admin',
  input: uploadInput,
  async run({ claims, address, input }) {
    const { upload } = uploadInput.parse(input)
    if (!claims.probe) throw forbidden('No app login was given')
    const t = claims.target
    return startUploadRestore(claims.sub, { address, port: t.port, db: t.db, user: t.user, password: t.password }, claims.probe, uploadedFile(upload, claims.sub), upload)
  },
}

const statusInput = z.object({ job: z.string().regex(/^[a-f0-9]{24}$/) })

export const restoreStatus: Op = {
  mode: 'admin',
  input: statusInput,
  async run({ claims, input }) {
    return jobStatus(statusInput.parse(input).job, claims.sub)
  },
}
