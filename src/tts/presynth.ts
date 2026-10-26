import { loadFillers } from '../content/fillers.js'
import { loadAnchors } from '../content/loader.js'
import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { CACHE_DIR, cachedSize, namedPath } from './cache.js'
import {
  isFresh, loadManifest, saveManifest, stalenessReason, type Manifest,
} from './manifest.js'
import { synthesize, ttsProvider } from './router.js'
import { resolveVoice, usingPlaceholderVoice, voiceEnvName } from './voices.js'
import type { Register } from '../planner/decide.js'

/**
 * 预合成固定台词 —— 规格 03 §7.2。
 *
 * 垫音和 Top 30 锚点的开场段，每个用户听到的都一样。
 * 一次合成、永久复用：现场零延迟、零成本，而且不受网络抖动影响。
 *
 * 用法：node --run tts:presynth
 */

const REGISTER_OF_VOICE: Record<string, Register> = {
  peer: 'peer', storyteller: 'storyteller', concise: 'concise',
}

type Outcome = { created: number; skipped: number; restaled: number; failed: number }

const synthOne = async (input: {
  readonly text: string
  readonly register: Register
  readonly namedKey: string
  readonly label: string
  readonly provider: string
  readonly manifest: Manifest
}, outcome: Outcome): Promise<void> => {
  const voice = resolveVoice(input.register, input.provider)
  const want = {
    provider: input.provider,
    voice: voice.voice,
    speedRatio: voice.speedRatio,
    text: input.text,
  }

  const existing = await cachedSize(namedPath(input.namedKey))
  const entry = input.manifest[input.namedKey]

  if (existing !== null && isFresh(entry, want)) {
    outcome.skipped += 1
    console.log(`  · 已有 ${input.namedKey}（${Math.round(existing / 1024)}KB）`)
    return
  }
  if (existing !== null) {
    outcome.restaled += 1
    console.log(`  ↻ 重合成 ${input.namedKey}：${stalenessReason(entry, want)}`)
  }

  try {
    const result = await synthesize(
      { text: input.text, voice: voice.voice, speedRatio: voice.speedRatio, encoding: 'mp3' },
      { namedKey: input.namedKey, forceRefresh: true },
    )
    if (result === null) throw new Error('合成返回空')
    outcome.created += 1
    input.manifest[input.namedKey] = {
      ...want,
      bytes: result.audio.byteLength,
      durationMs: result.durationMs,
      createdAt: new Date().toISOString(),
    }
    const dur = result.durationMs === null ? '' : ` ${result.durationMs}ms`
    console.log(
      `  ✓ ${input.namedKey}  ${Math.round(result.audio.byteLength / 1024)}KB${dur}  「${input.text}」`,
    )
  } catch (error) {
    outcome.failed += 1
    console.log(`  ✗ ${input.label}：${(error as Error).message}`)
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

  console.log(`\n── 预置垫音 ──`)
  const fillers = await loadFillers()
  for (const filler of fillers) {
    await synthOne({
      text: filler.text,
      register: REGISTER_OF_VOICE[filler.register] ?? 'peer',
      namedKey: filler.audioKey,
      label: filler.id,
      provider, manifest,
    }, outcome)
  }

  console.log(`\n── Top 30 锚点开场段（三种口吻）──`)
  const anchors = await loadAnchors()
  for (const anchor of anchors.values()) {
    if (!anchor.isTop30) continue
    const variants = [
      ['companion', 'peer', anchor.elements.openingHook.companion],
      ['child', 'storyteller', anchor.elements.openingHook.child],
      ['light', 'concise', anchor.elements.openingHook.light],
    ] as const
    for (const [voiceName, register, text] of variants) {
      if (text === null || text === '') continue
      await synthOne({
        text,
        register,
        namedKey: `anchors/${anchor.anchorId}.${voiceName}.mp3`,
        label: `${anchor.anchorId}/${voiceName}`,
        provider, manifest,
      }, outcome)
    }
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
