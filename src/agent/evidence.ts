import type { Anchor } from '../content/loader.js'
import type { Passage } from '../knowledge/weknora.js'

/**
 * 「这句话当时能看到的全部资料」。
 *
 * must_cite 回查（规格 03 §5.1）要拿它当底：漏掉一处合法来源，
 * 正确的回答就会被判成没依据然后打回重写——比不查还糟。
 *
 * 两处来源：K3 检索到的片段，以及锚点里人工精调的成稿。
 * 锚点只在有 K1 来源时才算数：没有来源的锚点文案本身就是录入缺陷，
 * `content/lint.ts` 的 evidence/missing_k1 在录入时就该拦住它，
 * 这里不替它背书。
 */

const stringLeaves = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringLeaves)
  }
  return []
}

export const evidenceTexts = (
  passages: readonly Passage[],
  anchor: Anchor | null,
): readonly string[] => [
  ...passages.map((p) => p.text),
  ...(anchor !== null && anchor.k1Sources.length > 0
    ? stringLeaves(anchor.elements)
    : []),
]
