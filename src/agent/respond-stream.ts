import { buildContextState } from '../context/state.js'
import { touchJourney } from '../context/journey.js'
import type { DeclaredSource } from '../context/provenance.js'
import { anchorForPlace, loadAnchors, type Anchor } from '../content/loader.js'
import { loadFillers, pickFiller, type Situation } from '../content/fillers.js'
import type { ContextState } from '../domain/context-state.js'
import { retrievePassages } from '../knowledge/weknora.js'
import { readLastFiller, recordFiller, recordSpoke } from '../memory/ephemeral.js'
import { writeMemory } from '../memory/gateway.js'
import { stream } from '../models/router.js'
import { checkCitations } from '../planner/cite-guard.js'
import { decidePlan, type PlanDecision } from '../planner/decide.js'
import { checkRegister } from '../planner/register-guard.js'
import { createSentenceSplitter } from '../planner/sentence.js'
import { ttsAvailability } from '../tts/availability.js'
import { pickTtsAdapter, synthesize, ttsProvider } from '../tts/router.js'
import { resolveVoice } from '../tts/voices.js'
import type { WireEvent } from '../../miniprogram/shared/stream-events.js'
import { evidenceTexts } from './evidence.js'
import { buildAnswerSystemPrompt } from './prompt.js'

/**
 * 流式应答 —— 规格 03 §7 的首句延迟对策。
 *
 * 事件顺序决定了用户的体感：
 *   filler（0ms，本地预合成音频）→ sentence（第一句一凑齐就送 TTS）→ done
 *
 * 实测依据：关掉深度思考后首个正文 delta 约 1.2s；垫音盖住这 1 秒，
 * 第一句话在约 1.3s 送进 TTS，用户感知上几乎没有空白。
 *
 * 与非流式路径的取舍：**流式下无法做「口吻守卫命中就重写」**——
 * 第一个字送出去就收不回来。所以这里守卫只作遥测，预防交给 system prompt
 * （实测约束形态后的 prompt 已能让回答一次通过）。需要强校验的场景
 * （游记、研学报告这类行后生成）继续走非流式的 onQuestion。
 */

export type StreamedEvent =
  | { readonly type: 'filler'; readonly text: string; readonly audioKey: string; readonly fillerId: string }
  | { readonly type: 'sentence'; readonly index: number; readonly text: string; readonly atMs: number }
  /**
   * 这一句的语音已就绪。刻意**不内联音频字节**：SSE 里塞 base64 会让
   * 事件流变重，而且没法交给 CDN。客户端拿 audioKey 去 /v1/audio/ 取。
   */
  | {
      readonly type: 'audio'
      readonly index: number
      readonly audioKey: string
      readonly durationMs: number | null
      readonly cached: boolean
      readonly synthMs: number
      readonly atMs: number
    }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done'
      readonly text: string
      readonly plan: PlanDecision
      readonly context: ContextState
      readonly guardViolations: readonly string[]
      readonly timing: Timing
    }
  | { readonly type: 'error'; readonly message: string; readonly fallbackText: string }

export type Timing = {
  /** 垫音发出的时刻：这是用户真正开始听到声音的时间 */
  readonly fillerAtMs: number
  /** 第一个正文增量到达的时刻 */
  readonly firstDeltaMs: number | null
  /** 第一句话凑齐、可以送 TTS 的时刻 */
  readonly firstSentenceMs: number | null
  /** 第一句语音就绪、可以播放的时刻。TTS 未配置时为 null */
  readonly firstAudioMs: number | null
  readonly totalMs: number
  readonly sentences: number
  readonly ttsProvider: string | null
}

let anchorCache: ReadonlyMap<string, Anchor> | null = null
const anchors = async (): Promise<ReadonlyMap<string, Anchor>> => {
  anchorCache ??= await loadAnchors()
  return anchorCache
}

/**
 * 合成一句话的语音并发出 audio 事件，返回就绪时刻。
 *
 * TTS 不可用时静默跳过——此时产品降级为「只显示文字」，
 * 而不是让整条应答失败（与规格 02 §4.3 视觉降级同一思路）。
 *
 * 合成是内联 await 的：第一句由垫音掩护，第二句往后在用户听前一句时合成，
 * 都不在关键路径上。真正的风险是单句合成慢到拖住模型流，所以单句出错只跳过这一句。
 */
async function* synthesizeSentence(
  text: string,
  index: number,
  voice: { readonly voice: string; readonly speedRatio: number },
  since: () => number,
): AsyncGenerator<StreamedEvent, number | null> {
  if (!ttsAvailability().available) return null

  const startedAt = since()
  try {
    const result = await synthesize(
      { text, voice: voice.voice, speedRatio: voice.speedRatio, encoding: 'mp3' },
    )
    if (result === null) return null
    const atMs = since()
    yield {
      type: 'audio',
      index,
      audioKey: result.path.split('audio-cache/')[1] ?? result.path,
      durationMs: result.durationMs,
      cached: result.cached,
      synthMs: atMs - startedAt,
      atMs,
    }
    return atMs
  } catch {
    // 一句合成失败不该让整段回答断掉；文字已经发出去了
    return null
  }
}

export type StreamQuestionInput = {
  readonly journeyId: string
  readonly text: string
  readonly poiId?: string | null
  readonly situation?: Situation
  readonly locationSource?: DeclaredSource
  readonly locationConfidence?: number
}

export async function* streamQuestion(
  input: StreamQuestionInput,
): AsyncGenerator<StreamedEvent> {
  const started = Date.now()
  const since = (): number => Date.now() - started

  await touchJourney(input.journeyId)
  const anchorMap = await anchors()
  const anchor = input.poiId == null ? null : anchorForPlace(anchorMap, input.poiId)

  const ctx = await buildContextState({
    journeyId: input.journeyId,
    poiId: input.poiId ?? null,
    currentTopic: anchor?.topics[0] ?? null,
    locationSource: input.locationSource,
    locationConfidence: input.locationConfidence,
  })

  const plan = decidePlan({
    context: ctx,
    anchor,
    trigger: { kind: 'user_question', text: input.text },
    heardBefore: [],
  })

  // 垫音先走：它不依赖模型，必须在任何网络调用之前发出
  const situation: Situation = input.situation ?? 'question'
  const [allFillers, lastId] = await Promise.all([
    loadFillers(),
    readLastFiller(input.journeyId),
  ])
  const filler = pickFiller(allFillers, {
    register: plan.register, situation, lastUsedId: lastId,
  })
  const fillerAtMs = since()
  if (filler !== null) {
    await recordFiller(input.journeyId, filler.id)
    yield {
      type: 'filler', text: filler.text,
      audioKey: filler.audioKey, fillerId: filler.id,
    }
  }

  const userWrite = await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'user',
    channel: 'text',
    content: input.text,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    occurredAt: new Date(),
  })
  if (!userWrite.ok) {
    yield {
      type: 'error',
      message: `write_rejected:${userWrite.reason}`,
      fallbackText: '这个话题我不太方便记下来，换个角度聊？',
    }
    return
  }

  if (anchor?.topics[0] !== undefined) {
    await writeMemory({
      kind: 'signal',
      userId: ctx.user,
      journeyId: input.journeyId,
      dimension: 'topic_interest',
      value: anchor.topics[0],
      source: 'explicit',
      evidenceInteractionId: userWrite.id,
      occurredAt: new Date(),
    })
  }

  // 垫音已经发出去了，这一跳藏在它后面：实测本地 BM25 检索约 23ms，垫音要念约 2s
  const passages = await retrievePassages({
    query: input.text, sceneId: anchor?.sceneId ?? null,
  })

  const ttsVerdict = ttsAvailability()
  // 按 TTS 适配器的上限切分：腾讯 150 汉字是硬上限，超了会被直接拒绝
  const maxChars = ttsVerdict.available ? pickTtsAdapter().maxChars : undefined
  const splitter = createSentenceSplitter({ maxChars })
  const voice = resolveVoice(plan.register, ttsProvider())
  let full = ''
  let firstDeltaMs: number | null = null
  let firstSentenceMs: number | null = null
  let firstAudioMs: number | null = null

  try {
    for await (const event of stream({
      task: 'qa',
      system: buildAnswerSystemPrompt({ ctx, plan, anchor, passages }),
      user: input.text,
      maxTokens: plan.maxTokens,
    })) {
      if (event.type === 'reasoning') continue // 思维链不给用户
      if (event.type === 'delta') {
        firstDeltaMs ??= since()
        full += event.text
        yield { type: 'delta', text: event.text }
        for (const sentence of splitter.push(event.text)) {
          firstSentenceMs ??= since()
          const index = splitter.count - 1
          yield { type: 'sentence', index, text: sentence, atMs: since() }
          const audio = yield* synthesizeSentence(sentence, index, voice, since)
          if (audio !== null) firstAudioMs ??= audio
        }
      }
    }
    for (const sentence of splitter.flush()) {
      firstSentenceMs ??= since()
      const index = splitter.count - 1
      yield { type: 'sentence', index, text: sentence, atMs: since() }
      const audio = yield* synthesizeSentence(sentence, index, voice, since)
      if (audio !== null) firstAudioMs ??= audio
    }
  } catch (error) {
    yield {
      type: 'error',
      message: (error as Error).message,
      fallbackText: '我这边卡了一下，你再问一遍？',
    }
    return
  }

  const guard = checkRegister(full, plan.register)
  /*
   * 回查（规格 03 §5.1）在这条路上只能记，不能拦——第一个字已经发出去了，
   * 收不回来，更没法像 respond.ts 那样降级成「我不确定」。
   * 预防交给 prompt 里的证据纪律；这里记下来，是为了让纠错队列能回答
   * 「这句话有没有依据」，也为了量出流式和非流式的差距到底有多大。
   */
  const cite = checkCitations(full, evidenceTexts(passages, anchor))

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'voice',
    content: full,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    evidenceRefs: {
      streamed: true,
      guardViolations: guard.violations.length,
      // 流式拦不住，只记：有没有念出没依据的事实、有没有挂错主语
      citeOk: cite.ok,
      citeViolations: cite.violations.map((v) => `${v.rule}:${v.label}:${v.value}`),
      // 同 respond.ts：纠错队列要回答「这条是从哪来的」
      k3: passages.map((p) => ({
        title: p.title, knowledgeId: p.knowledgeId, chunkId: p.chunkId,
      })),
    },
    occurredAt: new Date(),
  })
  await recordSpoke(input.journeyId, new Date())

  yield {
    type: 'done',
    text: full,
    plan,
    context: ctx,
    guardViolations: guard.violations.map((v) => `${v.rule}:${v.matched}`),
    timing: {
      fillerAtMs,
      firstDeltaMs,
      firstSentenceMs,
      firstAudioMs,
      totalMs: since(),
      sentences: splitter.count,
      ttsProvider: ttsVerdict.available ? ttsVerdict.provider : null,
    },
  }
}

/**
 * 编译期防漂移：服务端发出的事件必须仍然满足小程序侧的线上契约。
 * 改了 StreamedEvent 而忘了同步契约，这里会编译失败——
 * 跨网络的契约漂移在运行时只表现为「有时候没声音」，极难查。
 */
// 用元组包裹抑制分发：裸的 `A | B extends C` 会逐成员分发，
// 只要有一个成员满足结果就含 true，断言会形同虚设
type _WireContractHolds = [StreamedEvent] extends [WireEvent] ? true : never
const _wireContractHolds: _WireContractHolds = true
void _wireContractHolds
