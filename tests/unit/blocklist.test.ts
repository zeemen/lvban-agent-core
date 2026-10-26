import { describe, expect, test } from 'vitest'
import { checkBlocklist } from '../../src/memory/blocklist.js'

/** 规格 01 §3.2 的五类黑名单。对抗样例集——规格 01 §9.1 要求 ≥50 条，这里是起点。 */

describe('checkBlocklist 五类硬拦截', () => {
  test.each([
    ['health', '孩子对花生过敏，别带花生酥'],
    ['health', '我有高血压，走不了太快'],
    ['finance', '我月薪才八千，买不起这个'],
    ['finance', '家里房贷压力大'],
    ['sensitive_identity', '我是穆斯林，不吃猪肉'],
    ['sensitive_identity', '想了解一下政治立场相关的展览'],
    ['precise_home', '我家住在中山东路 321 号'],
  ])('拦住 %s 类内容：%s', (category, text) => {
    const verdict = checkBlocklist(text)

    expect(verdict.blocked).toBe(true)
    if (verdict.blocked) expect(verdict.category).toBe(category)
  })

  test.each([
    '这件青铜器是怎么做出来的',
    '江南贡院在哪个方向',
    '我走累了，想找个地方歇歇',
    '我对科举特别感兴趣',
  ])('放过正常旅行内容：%s', (text) => {
    expect(checkBlocklist(text).blocked).toBe(false)
  })

  test('空内容直接放过', () => {
    expect(checkBlocklist('   ').blocked).toBe(false)
  })
})

describe('checkBlocklist 推断画像', () => {
  test('系统推断的人格标签被拦截', () => {
    const verdict = checkBlocklist('性格内向，不爱和人说话', true)

    expect(verdict.blocked).toBe(true)
    if (verdict.blocked) expect(verdict.category).toBe('inferred_portrait')
  })

  test('推测家境被拦截', () => {
    const verdict = checkBlocklist('推测家境优越', true)

    expect(verdict.blocked).toBe(true)
  })

  test('同样的措辞若来自用户明确表达则不走画像规则', () => {
    // 画像规则只对 isInferred 生效：用户自己说「我看起来很累」不该被当成系统画像
    expect(checkBlocklist('我看起来很累吧', false).blocked).toBe(false)
  })
})
