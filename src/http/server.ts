import Fastify from 'fastify'
import { config } from '../config/index.js'
import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { checkK3Readiness, k3Report } from '../knowledge/readiness.js'
import { defaultClient, defaultKbMap } from '../knowledge/weknora.js'
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

/*
 * 启动时打一次真实的 K3 检索。
 *
 * 为什么不能只核对「配了没有」：2026-11-08 那次 K3 整条是死的，而配置是齐的。
 * 两个原因叠在一起——`.env` 的端口漂了，以及后端拒掉了我们那个纯 BM25 请求体
 * （Tencent/WeKnora#4899）。两者都只有真的发一次请求才看得见。
 *
 * 为什么必须在启动时说：retrievePassages 的降级是刻意的（语音优先，宁可少一条
 * 引用也不卡住这句话），代价是故障的表现和「库里确实没有」一模一样——
 * 模型只是忽然什么都不知道了。没有这一条，下一次照样是整月没人发现。
 *
 * 同样只报不拦：K3 本来就允许不配置，为一个可降级的子系统拒绝启动，
 * 炸的范围比问题本身大。自己兜住异常，核对坏了不该拖垮服务。
 */
const reportK3Readiness = async (): Promise<void> => {
  try {
    const { level, lines } = k3Report(await checkK3Readiness(defaultClient(), defaultKbMap()))
    app.log[level](lines.join('\n'))
  } catch (error: unknown) {
    app.log.error({ err: error }, 'K3 检索核对失败（服务照常提供，但自由问答可能没有长尾证据）')
  }
}

app.listen({ port: config.port, host: '0.0.0.0' })
  .then(async () => {
    app.log.info(`旅伴 Agent Core 已启动 :${config.port}（模型：${config.modelProvider}）`)
    await reportAudioReadiness()
    await reportK3Readiness()
  })
  .catch((error: unknown) => { app.log.error(error); process.exit(1) })
