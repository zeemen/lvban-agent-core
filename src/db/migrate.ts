import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pool, closePool } from './pool.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations')

const ensureRegistry = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
}

const appliedVersions = async (): Promise<ReadonlySet<string>> => {
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migration')
  return new Set(rows.map((r) => r.version))
}

const run = async (): Promise<void> => {
  await ensureRegistry()
  const applied = await appliedVersions()
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    const version = file.replace('.sql', '')
    if (applied.has(version)) {
      console.log(`skip  ${version}`)
      continue
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migration (version) VALUES ($1)', [version])
      await client.query('COMMIT')
      console.log(`apply ${version}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`迁移 ${version} 失败：${(error as Error).message}`, { cause: error })
    } finally {
      client.release()
    }
  }
}

run()
  .then(closePool)
  .catch(async (error: unknown) => {
    console.error(error)
    await closePool()
    process.exit(1)
  })
