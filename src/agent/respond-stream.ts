import { buildContextState } from '../context/state.js'
import { touchJourney } from '../context/journey.js'
import { anchorForPlace, loadAnchors, type Anchor } from '../content/loader.js'
import { loadFillers, pickFiller, type Situation } from '../content/fillers.js'
import type { ContextState } from '../domain/context-state.js'
import { readLastFiller, recordFiller, recordSpoke } from '../memory/ephemeral.js'
import { writeMemory } from '../memory/gateway.js'
import { stream } from '../models/router.js'
import { decidePlan, type PlanDecision } from '../planner/decide.js'
import { checkRegister } from '../planner/register-guard.js'
import { createSentenceSplitter } from '../planner/sentence.js'
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
  readonly totalMs: number
  readonly sentences: number
}

let anchorCache: ReadonlyMap<string, Anchor> | null = null
const anchors = async (): Promise<ReadonlyMap<string, Anchor>> => {
  anchorCache ??= await loadAnchors()
  return anchorCache
}

export type StreamQuestionInput = {
  readonly journeyId: string
  readonly text: string
  readonly poiId?: string | null
  readonly situation?: Situation
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

  const splitter = createSentenceSplitter()
  let full = ''
  let firstDeltaMs: number | null = null
  let firstSentenceMs: number | null = null

  try {
    for await (const event of stream({
      task: 'qa',
      system: buildAnswerSystemPrompt({ ctx, plan, anchor }),
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
          yield {
            type: 'sentence', index: splitter.count - 1,
            text: sentence, atMs: since(),
          }
        }
      }
    }
    for (const sentence of splitter.flush()) {
      firstSentenceMs ??= since()
      yield { type: 'sentence', index: splitter.count - 1, text: sentence, atMs: since() }
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

  await writeMemory({
    kind: 'interaction',
    userId: ctx.user,
    journeyId: input.journeyId,
    role: 'agent',
    channel: 'voice',
    content: full,
    anchorId: anchor?.anchorId ?? null,
    topicTags: anchor?.topics ?? [],
    evidenceRefs: { streamed: true, guardViolations: guard.violations.length },
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
      totalMs: since(),
      sentences: splitter.count,
    },
  }
}
