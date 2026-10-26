import Fastify from 'fastify'
import { config } from '../config/index.js'
import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { registerRoutes } from './routes.js'

const app = Fastify({ logger: { level: 'info' } })
registerRoutes(app)

const shutdown = async (): Promise<void> => {
  await app.close()
  await closePool()
  await closeRedis()
}

process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)) })

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => { app.log.info(`旅伴 Agent Core 已启动 :${config.port}（模型：${config.modelProvider}）`) })
  .catch((error: unknown) => { app.log.error(error); process.exit(1) })
