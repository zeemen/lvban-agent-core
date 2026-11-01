import { loadFillers } from '../content/fillers.js'
import { loadAnchors } from '../content/loader.js'
import { cachedSize, namedPath } from './cache.js'
import { isFresh, loadManifest, stalenessReason, type ManifestEntry } from './manifest.js'
import { presynthPlan, type PlanItem } from './plan.js'
import { ttsProvider } from './router.js'
import { resolveVoice } from './voices.js'

/**
 * 启动时核对预合成音频 —— 「该出声的地方没出声」要在启动时就说出来。
 *
 * 为什么值得专门查：取音频那个路由在缓存缺失时直接回 404（http/routes.ts），
 * 不会临时合成。所以漏跑一次 presynth，线上表现是垫音静默——用户只觉得
 * 「卡了一下」，日志里什么都没有。2026-11-01 这件事先在 CI 上现了一次形。
 *
 * 比「文件在不在」更要紧的是第二种：**文件在，但不是用现在这套音色合的**。
 * manifest.ts 的注释已经写明了这个坑——用 mock 预合成过一轮之后换上真供应商，
 * presynth 会因为文件已存在而全部跳过，线上播的就是假音频，而且不报错。
 * 所以这里复用 presynth 自己那套 isFresh 判定，不只看文件存不存在。
 */

export type AudioGap = {
  readonly audioKey: string
  readonly label: string
  readonly reason: string
}

export type AudioReadiness = {
  readonly provider: string
  readonly expected: number
  /** 文件根本不在：这条会 404 */
  readonly missing: readonly AudioGap[]
  /** 文件在，但供应商／音色／语速／文案已经对不上：播出去的是旧的或假的 */
  readonly stale: readonly AudioGap[]
}

export type ItemState = { readonly state: 'ok' | 'missing' | 'stale'; readonly reason: string }

/** 纯判定，便于反例测试：这一条音频现在算什么状态 */
export const itemState = (
  exists: boolean,
  entry: ManifestEntry | undefined,
  want: { readonly provider: string; readonly voice: string; readonly speedRatio: number; readonly text: string },
): ItemState => {
  if (!exists) return { state: 'missing', reason: '缓存里没有这个文件' }
  if (!isFresh(entry, want)) return { state: 'stale', reason: stalenessReason(entry, want) }
  return { state: 'ok', reason: '' }
}

export const checkAudioReadiness = async (): Promise<AudioReadiness> => {
  const provider = ttsProvider()
  const plan = presynthPlan(await loadFillers(), await loadAnchors())
  const manifest = await loadManifest()

  const missing: AudioGap[] = []
  const stale: AudioGap[] = []

  for (const item of plan) {
    const voice = resolveVoice(item.register, provider)
    const { state, reason } = itemState(
      await cachedSize(namedPath(item.audioKey)) !== null,
      manifest[item.audioKey],
      { provider, voice: voice.voice, speedRatio: voice.speedRatio, text: item.text },
    )
    if (state === 'missing') missing.push({ audioKey: item.audioKey, label: item.label, reason })
    if (state === 'stale') stale.push({ audioKey: item.audioKey, label: item.label, reason })
  }

  return { provider, expected: plan.length, missing, stale }
}

export type ReadinessReport = {
  readonly level: 'info' | 'warn' | 'error'
  readonly lines: readonly string[]
}

/** 纯函数：把核对结果写成人话。最多列 5 条，剩下的报个数 —— 启动日志不是清单 */
export const readinessReport = (r: AudioReadiness): ReadinessReport => {
  const ok = r.expected - r.missing.length - r.stale.length
  const head = `预合成音频 ${ok}/${r.expected} 条就绪（TTS 供应商：${r.provider}）`

  if (r.missing.length === 0 && r.stale.length === 0) {
    return { level: 'info', lines: [head] }
  }

  const sample = (gaps: readonly AudioGap[]): readonly string[] => [
    ...gaps.slice(0, 5).map((g) => `    ${g.label}（${g.audioKey}）：${g.reason}`),
    ...(gaps.length > 5 ? [`    …另有 ${gaps.length - 5} 条`] : []),
  ]

  return {
    /*
     * stale 比 missing 严重，所以抬一级。
     * 缺了是「该出声的地方没出声」；对不上是「播出去的不是现在这套音色」——
     * 后者用户听得见，但听不出是错的，日志不说就没人会发现。
     */
    level: r.stale.length > 0 ? 'error' : 'warn',
    lines: [
      head,
      ...(r.missing.length > 0 ? [`  缺 ${r.missing.length} 条（取音频会回 404）：`, ...sample(r.missing)] : []),
      ...(r.stale.length > 0 ? [`  对不上 ${r.stale.length} 条（播的不是现在这套音色）：`, ...sample(r.stale)] : []),
      '  跑 node --run tts:presynth 补齐。',
    ],
  }
}
