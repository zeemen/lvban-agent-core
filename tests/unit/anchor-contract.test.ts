import { describe, expect, test } from 'vitest'
import { anchorSchema, loadAnchors } from '../../src/content/loader.js'

/**
 * 交付契约自己的用例。
 *
 * 为什么值得单独测：`approved` 是唯一能把史实送进游记的开关（规格 04 §7.1，
 * 执行点 src/agent/travelogue.ts）。锚点改由知识库供应链中台产出之后，
 * 这一栏就成了上游自我声明的字段——校验写错了的话，它只会安静地全部放过，
 * 而「校验生效、文件也都合规」长得一模一样。所以每一条都要有反例。
 *
 * 契约全文见 content/supply-chain-contract.md。
 */

/** 最小可用锚点的原始 JSON。要素都填合法值，这样失败只会来自被测那一栏 */
const rawAnchor = (review: unknown): unknown => ({
  anchorId: 'fzm_test',
  name: '测试锚点',
  sceneId: 'fuzimiao',
  poiId: 'fzm_test',
  isTop30: true,
  topics: [],
  review,
  k1Sources: [{ title: '测试来源' }],
  elements: {
    openingHook: { companion: '你看这个。', child: null, light: null },
    observation: { companion: null, child: null, light: null },
    question: { companion: null, child: null, light: null },
    explanation: { companion: null, child: null, light: null },
    story: null,
    connection: { curriculum: null, presentDay: null },
    memoryLink: { template: '你上次在{place}问过{topic}。' },
    nextAction: { suggest: null, reason: '测试' },
  },
})

/** 规格 03 §9.2 要的那两个人 */
const signed = {
  status: 'approved',
  reviewedBy: ['内容负责人甲', '外部历史顾问乙'],
  reviewedAt: '2026-10-31',
  factCheckRequired: [],
}

/** 出错的字段路径；通过时是空数组 */
const badFields = (review: unknown): readonly string[] => {
  const parsed = anchorSchema.safeParse(rawAnchor(review))
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

describe('approved 必须带得出双签凭据', () => {
  test('两个不同署名 + 日期 + 待核清空：通过', () => {
    expect(badFields(signed)).toEqual([])
  })

  test('署名是空数组：拦住 —— 这是原先那个洞', () => {
    expect(badFields({ ...signed, reviewedBy: [] })).toContain('review.reviewedBy')
  })

  test('同一个署名写两遍：拦住 —— 双签不是签两次', () => {
    expect(badFields({ ...signed, reviewedBy: ['甲', '甲'] })).toContain('review.reviewedBy')
  })

  test('署名只有空白字符：拦住', () => {
    expect(badFields({ ...signed, reviewedBy: ['内容负责人甲', '   '] }))
      .toContain('review.reviewedBy')
  })

  test('审校日期为 null：拦住', () => {
    expect(badFields({ ...signed, reviewedAt: null })).toContain('review.reviewedAt')
  })

  test('审校日期不是 YYYY-MM-DD：拦住', () => {
    expect(badFields({ ...signed, reviewedAt: '2026年10月31日' }))
      .toContain('review.reviewedAt')
  })

  test('还挂着待核项：拦住 —— 常备提示该写进 note', () => {
    expect(badFields({ ...signed, factCheckRequired: ['尺寸无 K1'] }))
      .toContain('review.factCheckRequired')
  })

  test('报错信息说得出差在哪，不是一句「校验失败」', () => {
    const parsed = anchorSchema.safeParse(rawAnchor({ ...signed, reviewedBy: ['甲'] }))

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.message).toContain('双签')
  })
})

describe('draft 不受双签那几条约束', () => {
  /*
   * 这一条是护着现有内容的：四个锚点都是 draft，署名空、日期 null、
   * 待核项一堆。要是把约束加在 status 之外，它们会全部加载不了——
   * 而「静默地少讲」正是这个项目认定的最坏结果。
   */
  test('空署名 + null 日期 + 一堆待核项，draft 照样通过', () => {
    expect(badFields({
      status: 'draft',
      reviewedBy: [],
      reviewedAt: null,
      factCheckRequired: ['尺寸无 K1', '始建年代两源冲突'],
    })).toEqual([])
  })

  test('in_review 同样不受约束', () => {
    expect(badFields({
      status: 'in_review',
      reviewedBy: ['内容负责人甲'],
      reviewedAt: null,
      factCheckRequired: ['等外部顾问看一眼'],
    })).toEqual([])
  })
})

describe('真实内容仍然加载得起来', () => {
  test('loadAnchors 不抛', async () => {
    const anchors = await loadAnchors()

    expect(anchors.size).toBeGreaterThan(0)
  })
})
