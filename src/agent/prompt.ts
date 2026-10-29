import type { Anchor } from '../content/loader.js'
import type { ContextState } from '../domain/context-state.js'
import type { Passage } from '../knowledge/weknora.js'
import type { PlanDecision } from '../planner/decide.js'

/**
 * 自由问答的 system prompt。流式与非流式两条路径共用同一份。
 *
 * 为什么必须共用：流式路径做不了「守卫命中就重写」（第一个字送出去就收不回来），
 * 预防全靠这段 prompt。两边各写一份的话，质量约束迟早漂移。
 *
 * 形态约束和内容约束一样重要：这是语音优先的产品（规格 03：语音流、锁屏可听），
 * 实测不加约束时 deepseek-flash 会输出 3–4 段带空行的聊天体，TTS 念出来很怪。
 */

export type AnswerPromptInput = {
  readonly ctx: ContextState
  readonly plan: PlanDecision
  readonly anchor: Anchor | null
  /** K3 长尾检索命中的片段；取不到就是空数组，不是缺省值（规格 03 §5） */
  readonly passages?: readonly Passage[]
}

/**
 * 资料区。空的时候整段不出现——给模型一个空的「可引用的资料」标题，
 * 等于请它往里填东西。
 */
const evidenceBlock = (passages: readonly Passage[]): string => {
  if (passages.length === 0) return ''
  const list = passages
    .map((p, i) => `(${i + 1}) 【${p.title}】${p.text}`)
    .join('')
  return `【可引用的资料】${list}`
    + `年代、名称、尺寸、出土地点、人物关系、历史事件这六类只能来自上述资料；`
    + `资料里没写的就说不确定，不要补齐。用到哪条就顺口说出它的来源。`
}

export const buildAnswerSystemPrompt = (input: AnswerPromptInput): string => {
  const { ctx, plan, anchor } = input
  const passages = input.passages ?? []
  return [
    `你是旅伴 agent，一个陪用户旅行的同伴，不是客服也不是讲解器。`,
    `当前模式 ${ctx.mode}，口吻档位 ${plan.register}，用户年龄段 ${ctx.ageBand}。`,
    `【输出形态】只说一段话，${plan.maxChars} 字以内；`,
    `不分段、不空行、不用任何 Markdown 标记、不用「简单说」「首先」这类书面连接词；`,
    `像在现场开口说话，不像写文章。`,
    `不要连续陈述三句事实，每两句事实之间至少有一句对用户开口（提问、类比，或用「你」直接说）。`,
    anchor === null ? '' : `【当前位置】${anchor.name}。`,
    `【证据纪律】年代、名称、尺寸、出土地点、人物关系、历史事件必须有据可查；`,
    `没有把握就直接说不确定，并把人引向现场说明牌，不要含糊其辞、不要编。`,
    evidenceBlock(passages),
    ctx.memoryHooks.length === 0
      ? ''
      : `【可引用的记忆】${ctx.memoryHooks.join('；')}。自然地接上，不要生硬复述。`,
  ].join('')
}

/** 口吻守卫命中后的重写指令（仅非流式路径可用） */
export const buildRewriteSuffix = (violations: readonly string[], maxChars: number): string =>
  `【重写要求】上一版违反了口吻规则：${violations.join('、')}。` +
  `不要连续陈述三句事实，每两句事实之间至少有一句对用户开口` +
  `（提问、类比、或者用「你」直接说）。仍然只说一段话，${maxChars} 字以内。`
