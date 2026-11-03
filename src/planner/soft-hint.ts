import type { Anchor } from '../content/loader.js'
import type { SilentCard } from '../../miniprogram/shared/silent-card.js'
import { anchorHookAudioKey } from '../tts/plan.js'
import { VOICE_BY_REGISTER, type Register } from './decide.js'

/**
 * 静默卡片 —— 规格 02 §7.1 的 SOFT_HINT 那一档：「气泡/震动，不出声」。
 *
 * 分不够开口、或者主动频次到了（§7.4），都走这里。它不是降级后的残句，
 * 是另一种输出形态：不打断，但让人知道这儿有东西可讲。
 *
 * 刻意**不生成新文案**。气泡上那一句就是锚点八要素里精调过的开场钩子——
 * 它本来就是为「一句话勾住注意力」写的，而且 Top 30 的那批已经预合成过，
 * 所以点一下零延迟、零成本、零模型调用（同规格 03 §7.2 的缓存策略）。
 *
 * 纯函数，无 IO：要不要出卡片由主动性引擎定，出什么由这里定，
 * 写库和返回在 src/agent/respond.ts。
 */

/*
 * 形状定义在 miniprogram/shared/silent-card.ts —— 它整个都跨网络，
 * 所以单一来源，不在这边再写一份。几点约定记在这里：
 *
 * audioKey 只有 Top 30 才有，因为预合成清单只覆盖它们（tts/plan.ts 的
 * presynthPlan）。给非 Top 30 编一个键出来，结果是客户端取音频回 404——
 * 而那条路由刻意不临时合成。没有音频不等于没有卡片：文字照出，
 * 要不要显示播放按钮由客户端决定。
 */
export type { SilentCard }

/** 卡片 + 它用了八要素里的哪一栏（给 usedElements 用，不跨网络） */
export type BuiltCard = {
  readonly card: SilentCard
  readonly element: 'openingHook' | 'question' | 'observation'
}

export const buildSilentCard = (
  anchor: Anchor,
  register: Register,
  options: { readonly heard?: boolean } = {},
): BuiltCard | null => {
  const voice = VOICE_BY_REGISTER[register]
  const e = anchor.elements

  /*
   * 已听过就别把原话再推一遍（规格 03 §3.3「不重复主讲解，换一个侧面」）。
   *
   * 这不是边角情况：分数掉进 soft 区间最常见的原因恰恰就是「已听过」
   * （首访那 +0.20 没了），所以重访是这一档的主路径。把听过的那句重播一次，
   * 等于告诉用户这东西没记性。
   *
   * 换的代价是没有预合成音频：presynth 只覆盖开场钩子（tts/plan.ts），
   * 所以重访的卡片只有文字。宁可没声音，也不要重播。
   */
  type Candidate = {
    readonly text: string | null
    readonly element: BuiltCard['element']
  }
  const candidates: readonly Candidate[] = options.heard === true
    ? [
      { text: e.question[voice], element: 'question' },
      { text: e.observation[voice], element: 'observation' },
      // 这两栏都空着才退回开场钩子：有提示总比没提示好
      { text: e.openingHook[voice], element: 'openingHook' },
    ]
    : [{ text: e.openingHook[voice], element: 'openingHook' }]

  const picked = candidates.find((c) => c.text !== null && c.text !== '')
  // 这档口吻一栏都没写就不出卡片。宁可不提示，也不临时编一句
  if (picked === undefined || picked.text === null) return null

  const { text: hint, element } = picked
  return {
    card: {
      anchorId: anchor.anchorId,
      name: anchor.name,
      hint,
      // 只有开场钩子预合成过，而且只有 Top 30
      audioKey: element === 'openingHook' && anchor.isTop30
        ? anchorHookAudioKey(anchor.anchorId, register)
        : null,
    },
    element,
  }
}
