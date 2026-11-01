import Fastify from 'fastify'
import { config } from '../config/index.js'
import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { checkAudioReadiness, readinessReport } from '../tts/readiness.js'
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

/*
 * 启动时核对预合成音频。
 *
 * 为什么只报不拦：TTS 本来就是可降级的（未配置时产品只显示文字，不报错），
 * 为一个可降级的子系统拒绝启动，炸的范围比问题本身大。
 *
 * 但也不能不说。取音频那个路由在缓存缺失时直接回 404、不临时合成，
 * 所以漏跑一次 presynth 的线上表现是「该出声的地方没出声」，而日志里
 * 一个字都没有。级别按严重度分：缺文件 warn；音色对不上 error——
 * 后者是在播错的东西，用户听得见却听不出是错的。
 *
 * 放在 listen 之后，而且自己兜住异常：核对本身坏了不该拖垮服务。
 */
const reportAudioReadiness = async (): Promise<void> => {
  try {
    const { level, lines } = readinessReport(await checkAudioReadiness())
    app.log[level](lines.join('\n'))
  } catch (error: unknown) {
    app.log.error({ err: error }, '预合成音频核对失败（服务照常提供，但垫音可能是静默的）')
  }
}

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(async () => {
    app.log.info(`旅伴 Agent Core 已启动 :${config.port}（模型：${config.modelProvider}）`)
    await reportAudioReadiness()
  })
  .catch((error: unknown) => { app.log.error(error); process.exit(1) })
