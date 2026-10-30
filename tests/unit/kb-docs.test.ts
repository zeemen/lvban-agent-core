import { describe, expect, test } from 'vitest'
import { findGaps, parseKbDoc } from '../../src/content/kb-docs.js'

/**
 * K3 语料的房式格式解析 —— 运营后台「知识管理」要先能把 14 篇读成结构化的东西，
 * 才谈得上看出谁缺什么（规格 04 §274）。
 *
 * 下面这份是 content/knowledge/fuzimiao/kb-mingyuan.md 的原文，不是编的格式。
 */

const REAL = `# 南京市地方志办公室：禁烟名臣三登明远楼

知识ID：kb-mingyuan
场景：fuzimiao
关联锚点：fuzimiao-4
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
    expect(doc.anchors).toEqual(['fuzimiao-4'])
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
  const doc = parseKbDoc(REAL, 'fuzimiao/kb-mingyuan.md')

  test('「待补充原文定位」算缺定位', () => {
    expect(findGaps(doc, SCENES)).toContain('missing_locator')
  })

  test('「迁移待复核」算没过审校', () => {
    expect(findGaps(doc, SCENES)).toContain('unreviewed')
  })

  test('填好定位、审校通过后这两条就消失', () => {
    const ok = { ...doc, locator: '文内明远楼段', reviewStatus: '已双签审校' }
    const gaps = findGaps(ok, SCENES)
    expect(gaps).not.toContain('missing_locator')
    expect(gaps).not.toContain('unreviewed')
  })

  test('场景词对不上锚点的词表要报出来——文档写 museum、锚点写 nanjing_museum 就是这么漂的', () => {
    const drift = { ...doc, sceneId: 'museum' }
    expect(findGaps(drift, SCENES)).toContain('scene_mismatch')
    expect(findGaps(doc, SCENES)).not.toContain('scene_mismatch')
  })

  test('没有来源 URL 是最严重的一条', () => {
    expect(findGaps({ ...doc, sourceUrl: '' }, SCENES)).toContain('missing_source')
  })
})
