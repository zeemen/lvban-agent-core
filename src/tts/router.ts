import { createMockTts } from './mock.js'
import { createTencentTts } from './tencent.js'
import { createVolcengineTts } from './volcengine.js'
import {
  cacheKey, cachePath, namedPath, readCached, writeCached,
} from './cache.js'
import type { SynthesisRequest, SynthesisResult, TtsAdapter } from './types.js'

/**
 * TTS 路由与缓存。
 *
 * 规格 03 §7.2：固定台词一次合成、永久复用。
 * 这一层把「缓存命中」和「实时合成」统一成一个调用，
 * 让调用方不必关心某句话是不是预合成过。
 */

const envTrim = (key: string, env: NodeJS.ProcessEnv): string => (env[key] ?? '').trim()

let cached: { provider: string; adapter: TtsAdapter } | null = null

export const ttsProvider = (env: NodeJS.ProcessEnv = process.env): string =>
  envTrim('TTS_PROVIDER', env) === '' ? 'mock' : envTrim('TTS_PROVIDER', env)

export const pickTtsAdapter = (env: NodeJS.ProcessEnv = process.env): TtsAdapter => {
  const provider = ttsProvider(env)
  if (cached?.provider === provider) return cached.adapter

  const adapter = provider === 'mock'
    ? createMockTts()
    : provider === 'tencent'
      ? createTencentTts({
          secretId: envTrim('TENCENT_SECRET_ID', env),
          secretKey: envTrim('TENCENT_SECRET_KEY', env),
          region: envTrim('TENCENT_REGION', env) || undefined,
          sampleRate: Number(envTrim('TTS_SAMPLE_RATE', env)) || undefined,
        })
      : provider === 'volcengine'
        ? createVolcengineTts({
            appId: envTrim('VOLC_TTS_APP_ID', env),
            accessToken: envTrim('VOLC_TTS_ACCESS_TOKEN', env),
            cluster: envTrim('VOLC_TTS_CLUSTER', env) || undefined,
          })
        : (() => {
            throw new Error(
              `未知的 TTS 供应商：${provider}（可选：mock / tencent / volcengine）`,
            )
          })()

  cached = { provider, adapter }
  return adapter
}

export const resetTtsAdapter = (): void => {
  cached = null
}

export type SynthesizeOptions = {
  /** 固定台词用作者指定的稳定路径（如 fillers/peer_q_01.mp3），不走内容哈希 */
  readonly namedKey?: string
  /** 只读缓存：命中就返回，没命中返回 null，不发起合成 */
  readonly cacheOnly?: boolean
  /** 无视已有缓存重新合成（预合成脚本检测到音色/文案变更时用） */
  readonly forceRefresh?: boolean
}

export type CachedSynthesis = SynthesisResult & { readonly path: string }

/**
 * 合成一段语音，优先读缓存。
 * cacheOnly 时未命中返回 null —— 让调用方自己决定是降级还是实时合成。
 */
export const synthesize = async (
  request: SynthesisRequest,
  options: SynthesizeOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CachedSynthesis | null> => {
  const adapter = pickTtsAdapter(env)
  const encoding = request.encoding ?? 'mp3'
  const path = options.namedKey !== undefined
    ? namedPath(options.namedKey)
    : cachePath(cacheKey({
        provider: adapter.name,
        voice: request.voice,
        text: request.text,
        encoding,
        speedRatio: request.speedRatio ?? 1,
      }), encoding)

  const hit = options.forceRefresh === true ? null : await readCached(path)
  if (hit !== null) {
    return {
      audio: hit, encoding, durationMs: null,
      provider: adapter.name, latencyMs: 0, cached: true, path,
    }
  }
  if (options.cacheOnly === true) return null

  const result = await adapter.synthesize(request)
  await writeCached(path, result.audio)
  return { ...result, path }
}
