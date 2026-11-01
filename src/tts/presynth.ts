import { loadFillers } from '../content/fillers.js'
import { loadAnchors } from '../content/loader.js'
import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { CACHE_DIR, cachedSize, namedPath } from './cache.js'
import {
  isFresh, loadManifest, saveManifest, stalenessReason, type Manifest,
} from './manifest.js'
import { presynthPlan, type PlanItem } from './plan.js'
import { synthesize, ttsProvider } from './router.js'
import { resolveVoice, usingPlaceholderVoice, voiceEnvName } from './voices.js'

/**
 * 预合成固定台词 —— 规格 03 §7.2。
 *
 * 垫音和 Top 30 锚点的开场段，每个用户听到的都一样。
 * 一次合成、永久复用：现场零延迟、零成本，而且不受网络抖动影响。
 *
 * 用法：node --run tts:presynth
 */

type Outcome = { created: number; skipped: number; restaled: number; failed: number }

const synthOne = async (
  item: PlanItem,
  ctx: { readonly provider: string; readonly manifest: Manifest },
  outcome: Outcome,
): Promise<void> => {
  const voice = resolveVoice(item.register, ctx.provider)
  const want = {
    provider: ctx.provider,
    voice: voice.voice,
    speedRatio: voice.speedRatio,
    text: item.text,
  }

  const existing = await cachedSize(namedPath(item.audioKey))
  const entry = ctx.manifest[item.audioKey]

  if (existing !== null && isFresh(entry, want)) {
    outcome.skipped += 1
    console.log(`  · 已有 ${item.audioKey}（${Math.round(existing / 1024)}KB）`)
    return
  }
  if (existing !== null) {
    outcome.restaled += 1
    console.log(`  ↻ 重合成 ${item.audioKey}：${stalenessReason(entry, want)}`)
  }

  try {
    const result = await synthesize(
      { text: item.text, voice: voice.voice, speedRatio: voice.speedRatio, encoding: 'mp3' },
      { namedKey: item.audioKey, forceRefresh: true },
    )
    if (result === null) throw new Error('合成返回空')
    outcome.created += 1
    ctx.manifest[item.audioKey] = {
      ...want,
      bytes: result.audio.byteLength,
      durationMs: result.durationMs,
      createdAt: new Date().toISOString(),
    }
    const dur = result.durationMs === null ? '' : ` ${result.durationMs}ms`
    console.log(
      `  ✓ ${item.audioKey}  ${Math.round(result.audio.byteLength / 1024)}KB${dur}  「${item.text}」`,
    )
  } catch (error) {
    outcome.failed += 1
    console.log(`  ✗ ${item.label}：${(error as Error).message}`)
  }
}

const run = async (): Promise<void> => {
  const provider = ttsProvider()
  console.log(`TTS 供应商：${provider}`)
  console.log(`缓存目录：${CACHE_DIR}`)

  for (const register of ['peer', 'storyteller', 'concise'] as const) {
    const voice = resolveVoice(register, provider)
    const warn = usingPlaceholderVoice(register, provider)
      ? `  ⚠ 占位音色（未经核实），上线前请设 ${voiceEnvName(register)}`
      : ''
    console.log(`  音色 ${register.padEnd(12)} ${voice.voice} × ${voice.speedRatio}${warn}`)
  }

  const outcome: Outcome = { created: 0, skipped: 0, restaled: 0, failed: 0 }
  const manifest = await loadManifest()

  /*
   * 枚举走 plan.ts 的 presynthPlan，不在这里自己列一遍：
   * 启动检查（tts/readiness.ts）核对的就是同一份清单。各列一份的话，
   * 往后新增一类预合成内容，这里会合成它、那里却不查它。
   */
  const plan = presynthPlan(await loadFillers(), await loadAnchors())
  const ctx = { provider, manifest }

  console.log(`\n── 预置垫音 ──`)
  for (const item of plan.filter((i) => i.kind === 'filler')) {
    await synthOne(item, ctx, outcome)
  }

  console.log(`\n── Top 30 锚点开场段（三种口吻）──`)
  for (const item of plan.filter((i) => i.kind === 'anchor_hook')) {
    await synthOne(item, ctx, outcome)
  }

  await saveManifest(manifest)
  console.log(
    `\n新合成 ${outcome.created} 条 · 已存在 ${outcome.skipped} 条` +
    ` · 因音色/文案变更重合成 ${outcome.restaled} 条 · 失败 ${outcome.failed} 条`,
  )
  if (outcome.failed > 0) process.exitCode = 1
}

run()
  .then(async () => { await closePool(); await closeRedis() })
  .catch(async (error: unknown) => {
    console.error(error)
    await closePool(); await closeRedis()
    process.exit(1)
  })
