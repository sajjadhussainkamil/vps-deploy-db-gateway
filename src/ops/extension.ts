/** Lists, turns on and turns off Postgres extensions, from the short list a customer may use. */
import { z } from 'zod'
import { isAllowedExtension, quoteIdent } from '../bootstrap-sql.js'
import { withTx } from '../db.js'
import { badRequest } from '../errors.js'
import type { Op } from './types.js'

const input = z.object({
  action: z.enum(['list', 'enable', 'disable']),
  name: z.string().min(1).max(63).optional(),
})

export const extension: Op = {
  mode: 'admin',
  input,
  async run({ claims, address, input: raw }) {
    const req = input.parse(raw)
    if (req.action !== 'list' && (!req.name || !isAllowedExtension(req.name))) throw badRequest('That extension is not available')

    return withTx(claims, address, req.action === 'list' ? 'read' : 'write', async (tx) => {
      // The name was checked against the list above, then quoted.
      if (req.action === 'enable') await tx.unsafe(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(req.name!)}`)
      if (req.action === 'disable') await tx.unsafe(`DROP EXTENSION IF EXISTS ${quoteIdent(req.name!)}`)
      const rows = await tx<{ name: string; version: string }[]>`SELECT extname AS name, extversion AS version FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`
      return { installed: rows.map((r) => ({ name: r.name, version: r.version })) }
    })
  },
}
