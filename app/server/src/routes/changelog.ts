// app/server/src/routes/changelog.ts

import { Hono } from 'hono'
import { resolve, dirname } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { apiError } from '../errors'

const router = new Hono()

function readChangelog(): string | null {
  const dir = dirname(fileURLToPath(import.meta.url))
  // app/server/src/routes -> repo root
  try {
    return readFileSync(resolve(dir, '../../../../CHANGELOG.md'), 'utf8')
  } catch {
    return null
  }
}

router.get('/changelog', (c) => {
  const markdown = readChangelog()
  if (!markdown) {
    return apiError(c, 404, 'Changelog not found')
  }
  return c.json({ markdown })
})

export default router
