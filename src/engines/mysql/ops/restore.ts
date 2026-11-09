/** Restoring a MySQL database from a Coolify backup, a copy of another's, or a customer's file. */
import { statSync } from 'node:fs'
import { z } from 'zod'
import { assertBackupFile } from '../../../backup-files.js'
import { forbidden } from '../../../errors.js'
import type { Op } from '../../../ops/types.js'
import { uploadedFile } from '../../../uploads.js'
import { jobStatus, startRestore, startUploadRestore } from '../restore.js'

const restoreInput = z.object({ appUser: z.string().min(1).max(32) })

export const restore: Op = {
  mode: 'admin',
  input: restoreInput,
  async run({ claims, address, input }) {
    const { appUser } = restoreInput.parse(input)
    const file = await assertBackupFile(claims.file, undefined, 'mysql')
    return startRestore(claims, address, file.path, appUser)
  },
}

const uploadInput = z.object({ upload: z.string().regex(/^[a-f0-9]{24}$/), maxBytes: z.number().int().min(1) })

/** A customer's file runs as the application's own account, never as root. */
export const restoreUpload: Op = {
  mode: 'admin',
  input: uploadInput,
  async run({ claims, address, input }) {
    const { upload, maxBytes } = uploadInput.parse(input)
    if (!claims.probe) throw forbidden('No app login was given')
    const file = uploadedFile(upload, claims.sub)
    // Packed files may unpack to several times their size, but never past what the database holds.
    return startUploadRestore(claims, address, claims.probe, file, upload, Math.max(maxBytes, statSync(file).size))
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
