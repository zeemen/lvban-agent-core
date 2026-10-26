import pg from 'pg'
import { config } from '../config/index.js'

// pg 是 CJS 包，ESM 下只能默认导入后再解构
const { Pool } = pg

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 })

export const closePool = async (): Promise<void> => {
  await pool.end()
}
