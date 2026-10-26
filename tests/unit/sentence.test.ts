import { describe, expect, test } from 'vitest'
import { createSentenceSplitter } from '../../src/planner/sentence.js'

/** 增量分句 —— TTS 要在整段说完之前就开始合成，否则流式白做 */

describe('createSentenceSplitter', () => {
  test('一句话凑齐才吐出，不吐半句', () => {
    const s = createSentenceSplitter()

    expect(s.push('你现在站的这排小格子')).toEqual([])
    expect(s.push('就是考场，一人一间。')).toEqual(['你现在站的这排小格子就是考场，一人一间。'])
  })

  test('一次增量里有多句就一次全吐出来', () => {
    const s = createSentenceSplitter()

    const out = s.push('第一句话在这里。第二句话也在这里。')

    expect(out).toHaveLength(2)
  })

  test('标点跨分片到达时仍能正确断句', () => {
    const s = createSentenceSplitter()

    expect(s.push('考生进去就得待好几天')).toEqual([])
    expect(s.push('。')).toEqual(['考生进去就得待好几天。'])
  })

  test.each(['。', '！', '？', '；', '…'])('识别终止符 %s', (mark) => {
    const s = createSentenceSplitter()

    expect(s.push(`这是一句足够长的话${mark}`)).toHaveLength(1)
  })

  test('过短的首句与下一句合并，避免为「好。」单发一次 TTS', () => {
    const s = createSentenceSplitter()

    expect(s.push('好。')).toEqual([])
    expect(s.push('这才是真正要说的内容。')).toEqual(['好。这才是真正要说的内容。'])
  })

  test('flush 取出没有终止符的结尾', () => {
    const s = createSentenceSplitter()
    s.push('完整的一句话在这里。')

    expect(s.push('这段没有句号')).toEqual([])
    expect(s.flush()).toEqual(['这段没有句号'])
  })

  test('flush 后缓冲区清空，不会重复吐出', () => {
    const s = createSentenceSplitter()
    s.push('没有终止符的尾巴')

    expect(s.flush()).toHaveLength(1)
    expect(s.flush()).toEqual([])
  })

  test('count 反映已吐出的句数', () => {
    const s = createSentenceSplitter()
    s.push('第一句话足够长了。第二句话也足够长。')

    expect(s.count).toBe(2)
  })

  test('空增量不产生句子', () => {
    const s = createSentenceSplitter()

    expect(s.push('')).toEqual([])
    expect(s.flush()).toEqual([])
  })
})
