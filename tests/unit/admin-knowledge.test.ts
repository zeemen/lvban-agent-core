import { describe, expect, test } from 'vitest'
import { adminToolsEnabled, renderDraft } from '../../src/http/admin-knowledge.js'
import { parseKbDoc } from '../../src/content/kb-docs.js'

/**
 * 运营后台的两条硬约束。
 *
 * 一、默认关闭。这些路由能按人填的任意地址发请求、能读仓库里的语料，而且没有鉴权。
 *    它只配活在开发机上，所以「忘了配」必须等于「关着」，不能等于「开着」。
 * 二、生成器和解析器必须认同一套房式格式。两边一旦漂移，页面生成的草稿存进仓库后
 *    维护面板就读不出字段，表现是「莫名其妙全是缺字段」，极难查。
 */

describe('默认关闭', () => {
  test('没设 ADMIN_TOOLS 就是关的', () => {
    expect(adminToolsEnabled({})).toBe(false)
  })

  test('只有显式的 "true" 才算开，别的值一律当关', () => {
    expect(adminToolsEnabled({ ADMIN_TOOLS: 'true' })).toBe(true)
    for (const v of ['false', '1', 'yes', 'TRUE', '']) {
      expect(adminToolsEnabled({ ADMIN_TOOLS: v }), v).toBe(false)
    }
  })
})

describe('生成的草稿，解析器要能原样读回来', () => {
  const input = {
    title: '南京中国科举博物馆：江南贡院号舍',
    knowledgeId: 'kb-haoshe',
    sceneId: 'fuzimiao',
    anchors: 'fzm_tianxia_wenshu、fzm_dacheng_dian',
    keywords: '号舍、乡试、尺寸、木板、搜检',
    sourceUrl: 'https://en.njiemuseum.com/xuetang_1/6.html',
    locator: '文内号舍形制与三场九天段',
    checkedAt: '2026-10-30',
    publishedAt: '未记录',
    reviewStatus: '迁移待复核；不以平台解析成功代替内容审校。',
    summary: '每间号舍高六尺，深四尺，宽三尺。白天上层木板代替桌案、下层为坐凳，夜晚并作床。',
  }

  test('每个字段都回得来', () => {
    const doc = parseKbDoc(renderDraft(input), 'fuzimiao/kb-haoshe.md')
    expect(doc).toMatchObject({
      title: input.title,
      knowledgeId: input.knowledgeId,
      sceneId: input.sceneId,
      sourceUrl: input.sourceUrl,
      locator: input.locator,
      checkedAt: input.checkedAt,
      reviewStatus: input.reviewStatus,
    })
    expect(doc.anchors).toEqual(['fzm_tianxia_wenshu', 'fzm_dacheng_dian'])
    expect(doc.keywords).toEqual(['号舍', '乡试', '尺寸', '木板', '搜检'])
    expect(doc.summary).toBe(input.summary)
  })

  test('刚生成的草稿一定是「缺审校」状态——不能默认就算过了审', () => {
    const doc = parseKbDoc(renderDraft(input), 'x.md')
    expect(doc.reviewStatus).toMatch(/待复核/)
  })

  test('结构和现有语料一致：标题行、两个二级标题、末尾免责', () => {
    const md = renderDraft(input)
    expect(md.startsWith('# ')).toBe(true)
    expect(md).toContain('## 来源与核对')
    expect(md).toContain('## 资料摘要与适用边界')
    expect(md.trimEnd().endsWith('本摘要不是对关联锚点全部事实的完整覆盖。')).toBe(true)
  })
})
