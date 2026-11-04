/** Changing a database's structure. One request is one transaction: it all happens or none of it does. */
import { z } from 'zod'
import { actionSchema, buildStatements, DesignError } from '../designer.js'
import { withTx } from '../db.js'
import { badRequest } from '../errors.js'
import type { Op } from './types.js'

const input = z.object({ action: actionSchema })

export const ddl: Op = {
  mode: 'write',
  input,
  async run({ claims, address, input: raw }) {
    const { action } = input.parse(raw)
    let statements: string[]
    try {
      statements = buildStatements(action)
    } catch (e) {
      if (e instanceof DesignError) throw badRequest(e.message)
      throw e
    }
    return withTx(claims, address, 'write', async (tx) => {
      for (let i = 0; i < statements.length; i++) {
        try {
          await tx.unsafe(statements[i]!)
        } catch (e) {
          if (e && typeof e === 'object') (e as { statementIndex?: number }).statementIndex = i
          throw e
        }
      }
      return { sql: statements }
    })
  },
}
