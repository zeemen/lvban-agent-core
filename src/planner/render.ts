import type { Anchor } from '../content/loader.js'
import type { PlanDecision, Register } from './decide.js'

/**
 * 文案组装 —— 把人工精调的锚点要素按决策拼成一段话。
 *
 * 规格 03 §7.2：Top 30 锚点的开场段是确定的，可全量预生成并缓存。
 * 所以这一层不调模型：锚点命中的讲解零模型调用、零延迟。
 * 只有「针对随机提问的回答」才走 Model Router（见 src/agent/respond.ts）。
 */

const VOICE_BY_REGISTER = { peer: 'companion', storyteller: 'child', concise: 'light' } as const

type Voice = (typeof VOICE_BY_REGISTER)[Register]

const pick = (
  field: { readonly companion: string | null; readonly child: string | null; readonly light: string | null },
  voice: Voice,
): string | null => field[voice]

/** memory_hook 格式 <city>·<place>·<topic>，按锚点的 memoryLink.template 填充 */
export const fillMemoryLink = (
  template: string, hook: string, hereName: string,
): string | null => {
  const parts = hook.split('·')
  if (parts.length < 2) return null
  const place = parts[1] ?? ''
  const topic = parts[2] ?? ''
  const filled = template
    .replaceAll('{place}', place)
    .replaceAll('{topic}', topic)
    .replaceAll('{here}', hereName)
  // 模板槽位没填满就不要输出半句话
  return /\{[a-z]+\}/.test(filled) ? null : filled
}

const LENGTH_SEGMENT_CAP: Record<PlanDecision['length'], number> = {
  short: 1,
  medium: 3,
  long: 5,
}

export type RenderedUtterance = {
  readonly text: string
  readonly segments: readonly string[]
  readonly usedElements: readonly string[]
  readonly fromCache: boolean
}

export const renderFromAnchor = (
  anchor: Anchor, decision: PlanDecision,
): RenderedUtterance => {
  const voice = VOICE_BY_REGISTER[decision.register]
  const e = anchor.elements
  const segments: string[] = []
  const used: string[] = []

  const push = (text: string | null, element: string): void => {
    if (text === null || text === '') return
    if (segments.length >= LENGTH_SEGMENT_CAP[decision.length]) return
    segments.push(text)
    used.push(element)
  }

  switch (decision.openWith) {
    case 'memory_link': {
      const link = decision.linkMemory === null
        ? null
        : fillMemoryLink(e.memoryLink.template, decision.linkMemory, anchor.name)
      // 记忆槽位填不满就退回提问开场，不输出残句
      push(link ?? pick(e.question, voice) ?? pick(e.openingHook, voice), 'memoryLink')
      break
    }
    case 'question':
      push(pick(e.openingHook, voice), 'openingHook')
      push(pick(e.question, voice), 'question')
      break
    case 'observation':
      push(pick(e.openingHook, voice), 'openingHook')
      push(pick(e.observation, voice), 'observation')
      break
    case 'fact':
      push(pick(e.explanation, voice), 'explanation')
      break
  }

  if (decision.openWith !== 'fact' && !decision.skipMainExplanation) {
    push(pick(e.explanation, voice), 'explanation')
  }
  // 重访时优先给故事与当下连接，而不是把主讲解再念一遍
  if (decision.useStory || decision.skipMainExplanation) push(e.story, 'story')
  if (decision.linkCurriculum && e.connection.curriculum !== null) {
    push(`课本里也有：${e.connection.curriculum.stage}·${e.connection.curriculum.ref}`, 'curriculum')
  }
  if (decision.length !== 'short') push(e.connection.presentDay, 'presentDay')

  return {
    text: segments.join(' '),
    segments,
    usedElements: used,
    fromCache: true,
  }
}
