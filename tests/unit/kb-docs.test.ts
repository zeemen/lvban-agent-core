import { describe, expect, test } from 'vitest'
import { findGaps, parseKbDoc, type KbDoc } from '../../src/content/kb-docs.js'

/**
 * K3 语料的房式格式解析 —— 运营后台「知识管理」要先能把 14 篇读成结构化的东西，
 * 才谈得上看出谁缺什么（规格 04 §274）。
 *
 * 下面这份是 content/knowledge/fuzimiao/kb-mingyuan.md 的原文，不是编的格式。
 */

const REAL = `# 南京市地方志办公室：禁烟名臣三登明远楼

知识ID：kb-mingyuan
场景：fuzimiao
关联锚点：fzm_mingyuan_lou
关键词：明远楼、建筑、中轴线、始建、年代

## 来源与核对

来源：https://dfz.nanjing.gov.cn/gzdt/202502/t20250225_5082192.html
原文定位：待补充原文定位
核对日期：2026-10-25
资料发布日期：2025-02-25
审核状态：迁移待复核；不以平台解析成功代替内容审校。

## 资料摘要与适用边界

江南贡院明远楼位于贡院建筑群中轴线上，始建于明永乐年间，清道光年间重建。可结合建筑在考场中的位置提出观察问题，不能据此推断今日现场的开放安排。

本摘要不是对关联锚点全部事实的完整覆盖。
`

describe('读懂一篇语料', () => {
  const doc = parseKbDoc(REAL, 'fuzimiao/kb-mingyuan.md')

  test('标题取首行，不带井号', () => {
    expect(doc.title).toBe('南京市地方志办公室：禁烟名臣三登明远楼')
  })

  test('知识ID、场景、来源各归各位', () => {
    expect(doc).toMatchObject({
      knowledgeId: 'kb-mingyuan',
      sceneId: 'fuzimiao',
      sourceUrl: 'https://dfz.nanjing.gov.cn/gzdt/202502/t20250225_5082192.html',
      checkedAt: '2026-10-25',
      publishedAt: '2025-02-25',
    })
  })

  test('顿号分隔的锚点与关键词拆成数组', () => {
    expect(doc.anchors).toEqual(['fzm_mingyuan_lou'])
    expect(doc.keywords).toEqual(['明远楼', '建筑', '中轴线', '始建', '年代'])
  })

  test('摘要只取正文，不要末尾那句固定免责', () => {
    expect(doc.summary).toContain('始建于明永乐年间')
    expect(doc.summary).not.toContain('本摘要不是对关联锚点')
  })

  test('缺字段不抛错，留空让面板显示出来——解析失败不该让整页打不开', () => {
    const doc2 = parseKbDoc('# 只有标题\n', 'x.md')
    expect(doc2.title).toBe('只有标题')
    expect(doc2.knowledgeId).toBe('')
    expect(doc2.keywords).toEqual([])
  })
})

describe('看出一篇缺什么', () => {
  const SCENES = ['fuzimiao', 'nanjing_museum']
  /** 真实状态：30 个锚点只建了 2 个 */
  const ANCHORS = ['fzm_jiangnan_gongyuan_haoshe', 'njm_cuojinyin_hu']
  const KNOWN = { scenes: SCENES, anchors: ANCHORS }
  const doc = parseKbDoc(REAL, 'fuzimiao/kb-mingyuan.md')

  test('「待补充原文定位」算缺定位', () => {
    expect(findGaps(doc, KNOWN)).toContain('missing_locator')
  })

  test('「迁移待复核」算没过审校', () => {
    expect(findGaps(doc, KNOWN)).toContain('unreviewed')
  })

  test('填好定位、审校通过后这两条就消失', () => {
    const ok = { ...doc, locator: '文内明远楼段', reviewStatus: '已双签审校' }
    const gaps = findGaps(ok, KNOWN)
    expect(gaps).not.toContain('missing_locator')
    expect(gaps).not.toContain('unreviewed')
  })

  test('场景词对不上锚点的词表要报出来——文档写 museum、锚点写 nanjing_museum 就是这么漂的', () => {
    const drift = { ...doc, sceneId: 'museum' }
    expect(findGaps(drift, KNOWN)).toContain('scene_mismatch')
    expect(findGaps(doc, KNOWN)).not.toContain('scene_mismatch')
  })

  test('没有来源 URL 是最严重的一条', () => {
    expect(findGaps({ ...doc, sourceUrl: '' }, KNOWN)).toContain('missing_source')
  })
})

/**
 * 关联锚点这一栏指不到东西，是语料侧最隐蔽的一类缺陷：
 * 面板上看着「齐了」，实际应答路径取不到锚点，K1 和八要素都到不了用户。
 * 占位编号和「锚点还没建」要分开——前者是写错了，后者是进度。
 */
describe('关联锚点指不到东西', () => {
  const KNOWN = {
    scenes: ['fuzimiao', 'nanjing_museum'],
    anchors: ['fzm_jiangnan_gongyuan_haoshe', 'njm_cuojinyin_hu'],
  }
  const withAnchors = (value: string): KbDoc =>
    parseKbDoc(REAL.replace('关联锚点：fzm_mingyuan_lou', `关联锚点：${value}`), 'x.md')

  test('fuzimiao-4 这种编号是占位：连指的是什么都看不出来', () => {
    expect(findGaps(withAnchors('fuzimiao-4'), KNOWN)).toContain('anchor_placeholder')
  })

  test('museum-1 同样是占位', () => {
    expect(findGaps(withAnchors('museum-1'), KNOWN)).toContain('anchor_placeholder')
  })

  test('规格 04 §4.1 的正式 id 但锚点还没建 —— 是进度，不是写错', () => {
    const gaps = findGaps(withAnchors('fzm_mingyuan_lou'), KNOWN)
    expect(gaps).toContain('anchor_missing')
    expect(gaps).not.toContain('anchor_placeholder')
  })

  test('锚点建好了就两条都不报', () => {
    const gaps = findGaps(withAnchors('fzm_jiangnan_gongyuan_haoshe'), KNOWN)
    expect(gaps).not.toContain('anchor_placeholder')
    expect(gaps).not.toContain('anchor_missing')
  })

  test('一行里混着好的和占位的，占位那个照样报', () => {
    const gaps = findGaps(withAnchors('njm_cuojinyin_hu、museum-9'), KNOWN)
    expect(gaps).toContain('anchor_placeholder')
  })

  test('写「未记录」是没挂锚点，不是写错了：这一类不报', () => {
    const gaps = findGaps(withAnchors('未记录'), KNOWN)
    expect(gaps).not.toContain('anchor_placeholder')
    expect(gaps).not.toContain('anchor_missing')
  })
})

/**
 * 场景词漂移：6 篇写「场景：museum」，而锚点和目录都叫 nanjing_museum。
 *
 * 这个字段目前不进应答路径（检索和 zoneHint 用的都是锚点的 sceneId），
 * 所以它不会让谁少听一句话——但它是个指向不存在场景的标签，
 * 等到哪天真有代码按它选库，错就从「标签不准」变成「检索整篇取不到」。
 */
describe('场景词对不上', () => {
  const KNOWN = {
    scenes: ['fuzimiao', 'nanjing_museum'],
    anchors: ['fzm_jiangnan_gongyuan_haoshe', 'njm_cuojinyin_hu'],
  }
  const withScene = (value: string): KbDoc =>
    parseKbDoc(REAL.replace('场景：fuzimiao', `场景：${value}`), 'nanjing_museum/x.md')

  test('museum 不在锚点的场景词表里', () => {
    expect(findGaps(withScene('museum'), KNOWN)).toContain('scene_mismatch')
  })

  test('nanjing_museum 对得上', () => {
    expect(findGaps(withScene('nanjing_museum'), KNOWN)).not.toContain('scene_mismatch')
  })

  test('锚点一个都没加载出来时不报：拿空词表比，只会把 17 篇全判成错', () => {
    const gaps = findGaps(withScene('museum'), { scenes: [], anchors: [] })
    expect(gaps).not.toContain('scene_mismatch')
  })
})
