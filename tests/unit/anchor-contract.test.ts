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

const owner = { role: 'content_owner', account: 'owner@example.com' }
const advisor = { role: 'history_advisor', account: 'advisor@example.com' }

/** 规格 03 §9.2 要的那两方 */
const signed = {
  status: 'approved',
  reviewedBy: [owner, advisor],
  reviewedAt: '2026-10-31',
  factCheckRequired: [],
}

/** 出错的字段路径；通过时是空数组 */
const badFields = (review: unknown): readonly string[] => {
  const parsed = anchorSchema.safeParse(rawAnchor(review))
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

/** 报错信息全文，用来确认它说得出差在哪 */
const message = (review: unknown): string => {
  const parsed = anchorSchema.safeParse(rawAnchor(review))
  return parsed.success ? '' : parsed.error.message
}

describe('approved 必须带得出双签凭据', () => {
  test('两方各一个账号 + 日期 + 待核清空：通过', () => {
    expect(badFields(signed)).toEqual([])
  })

  test('署名是空数组：拦住 —— 这是原先那个洞', () => {
    expect(badFields({ ...signed, reviewedBy: [] })).toContain('review.reviewedBy')
  })

  test('缺外部历史顾问：拦住，而且点名缺的是哪一方', () => {
    expect(badFields({ ...signed, reviewedBy: [owner] })).toContain('review.reviewedBy')
    expect(message({ ...signed, reviewedBy: [owner] })).toContain('外部历史顾问')
  })

  test('缺内容负责人：拦住', () => {
    expect(message({ ...signed, reviewedBy: [advisor] })).toContain('内容负责人')
  })

  /*
   * 双签要的是「两方」，不是「两条」。这两条分别挡住两种假双签：
   * 同一方换个账号签两遍，以及同一个账号兼任两方。
   */
  test('同一方签两遍（两个账号都是内容负责人）：拦住', () => {
    const second = { role: 'content_owner', account: 'owner2@example.com' }

    expect(badFields({ ...signed, reviewedBy: [owner, second] })).toContain('review.reviewedBy')
  })

  test('同一个账号兼任两方：拦住', () => {
    const both = [owner, { role: 'history_advisor', account: owner.account }]

    expect(badFields({ ...signed, reviewedBy: both })).toContain('review.reviewedBy')
    expect(message({ ...signed, reviewedBy: both })).toContain('兼任')
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
    expect(message({ ...signed, reviewedBy: [owner] })).toContain('双签')
  })
})

describe('署名得指得到中台的一个账号', () => {
  /*
   * 这一组是形状校验，和 status 无关：手打一个名字当署名，谁都查不到是谁。
   * account 要求是中台已规范化的邮箱（见 loader.ts 的 reviewSignerSchema），
   * 这样它能直接按 users.email 等值查到人——大小写不一致的话，那条联查会
   * 静默查不到，而不是报错。
   */
  test('手打名字不是账号：拦住，并指到具体那一条', () => {
    expect(badFields({ ...signed, reviewedBy: [{ role: 'content_owner', account: '内容负责人甲' }, advisor] }))
      .toContain('review.reviewedBy.0.account')
  })

  test('大写没规范化：拦住 —— 否则按 users.email 查不到人', () => {
    const upper = { role: 'content_owner', account: 'Owner@Example.com' }

    expect(badFields({ ...signed, reviewedBy: [upper, advisor] }))
      .toContain('review.reviewedBy.0.account')
    expect(message({ ...signed, reviewedBy: [upper, advisor] })).toContain('小写')
  })

  test('账号里带空白：拦住', () => {
    const padded = { role: 'content_owner', account: ' owner@example.com ' }

    expect(badFields({ ...signed, reviewedBy: [padded, advisor] }))
      .toContain('review.reviewedBy.0.account')
  })

  /*
   * 中台的工作区角色是 owner/editor/reviewer/viewer，会随人事变动改；
   * 这里要的是治理身份，签下就不再变。抄错了要拦住。
   */
  test('填的是中台的工作区角色而不是治理身份：拦住', () => {
    expect(badFields({ ...signed, reviewedBy: [{ role: 'reviewer', account: 'owner@example.com' }, advisor] }))
      .toContain('review.reviewedBy.0.role')
  })

  test('draft 也要形状对 —— 查不到人的署名什么状态下都是错的', () => {
    expect(badFields({
      status: 'draft',
      reviewedBy: [{ role: 'content_owner', account: '内容负责人甲' }],
      reviewedAt: null,
      factCheckRequired: [],
    })).toContain('review.reviewedBy.0.account')
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

  test('只签了一方、还等着外部顾问，in_review 照样通过', () => {
    expect(badFields({
      status: 'in_review',
      reviewedBy: [owner],
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
