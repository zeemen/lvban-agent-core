import type { Filler } from '../content/fillers.js'
import type { Anchor } from '../content/loader.js'
import type { Register } from '../planner/decide.js'

/**
 * 预合成清单 —— 哪些固定台词该有音频。
 *
 * 单独抽出来，是为了让 presynth（生产这批音频的）和启动检查（核对这批音频
 * 在不在、还新不新的）**用同一份枚举**。各写一份的话，往后新增一类预合成
 * 内容时，presynth 会合成它、检查却不查它——于是缺了也没人说。
 * 这个项目已经因为「两套规则各走一边」踩过一次（门禁与维护面板的锚点词表）。
 */

export type PlanItem = {
  /** 'filler' 垫音；'anchor_hook' Top 30 锚点的开场段 */
  readonly kind: 'filler' | 'anchor_hook'
  readonly audioKey: string
  readonly text: string
  readonly register: Register
  /** 给人看的标识，出错时用它定位 */
  readonly label: string
}

const REGISTER_OF_VOICE: Record<string, Register> = {
  peer: 'peer', storyteller: 'storyteller', concise: 'concise',
}

/** Top 30 锚点的开场段按三种口吻各合一条（规格 03 §7.2） */
const anchorItems = (anchor: Anchor): readonly PlanItem[] => {
  const variants = [
    ['companion', 'peer', anchor.elements.openingHook.companion],
    ['child', 'storyteller', anchor.elements.openingHook.child],
    ['light', 'concise', anchor.elements.openingHook.light],
  ] as const

  return variants.flatMap(([voiceName, register, text]) =>
    text === null || text === ''
      ? []
      : [{
        kind: 'anchor_hook' as const,
        audioKey: `anchors/${anchor.anchorId}.${voiceName}.mp3`,
        text,
        register,
        label: `${anchor.anchorId}/${voiceName}`,
      }])
}

export const presynthPlan = (
  fillers: readonly Filler[],
  anchors: ReadonlyMap<string, Anchor>,
): readonly PlanItem[] => [
  ...fillers.map((filler) => ({
    kind: 'filler' as const,
    audioKey: filler.audioKey,
    text: filler.text,
    register: REGISTER_OF_VOICE[filler.register] ?? 'peer',
    label: filler.id,
  })),
  ...[...anchors.values()].filter((a) => a.isTop30).flatMap(anchorItems),
]
