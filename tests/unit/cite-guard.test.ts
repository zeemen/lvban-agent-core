import { describe, expect, test } from 'vitest'
import {
  buildCiteRewriteSuffix, checkCitations, extractCitedValues,
} from '../../src/planner/cite-guard.js'

/**
 * must_cite 回查校验 —— 规格 03 §5.1 的受限通道那一半。
 *
 * 这个文件里的例子不是编的，是 2026-10-30 线上实测抽出来的。
 * 同一个问题「明远楼是什么时候建的」连问 5 次，4 次把两个年代分得很清，
 * 1 次说成「资料里说法不一，有说南宋乾道四年，也有说明永乐年间」——
 * 把江南贡院的年代当成了明远楼的竞争说法。两个年代都在资料里，
 * 错的是它们被挂到了谁身上。
 *
 * 所以校验分两层，强弱分明：
 *   一、containment（硬）：值必须在证据里出现过。拦的是凭空捏造，无阈值、无误报。
 *   二、attribution（软）：值前面那段话得和证据里同一个值前面那段话对得上。
 *       拦的是上面那种张冠李戴。这一层是启发式，会误伤省略主语的口语，
 *       所以只报警不打回——误伤一次correct答案的代价是让用户多等一轮重写。
 */

const EV_GONGYUAN =
  '江南贡院始建于南宋乾道四年（1168年）。明远楼是江南贡院的重要组成部分，'
  + '后成为中国科举博物馆的标志性建筑之一。'
const EV_MINGYUAN =
  '江南贡院明远楼位于贡院建筑群中轴线上，始建于明永乐年间，清道光年间重建。'
const EVIDENCE = [EV_GONGYUAN, EV_MINGYUAN]

describe('认出哪些话是 must_cite 字段', () => {
  test('年代：朝代纪年与公元年份都算', () => {
    expect(extractCitedValues('江南贡院是南宋乾道四年建的，也就是1168年')
      .map((v) => v.value)).toEqual(['南宋乾道四年', '1168年'])
  })

  test('尺寸与出土地点', () => {
    expect(extractCitedValues('这件高32厘米').map((v) => v.label)).toEqual(['尺寸'])
    expect(extractCitedValues('出土于大云山汉墓').map((v) => v.label)).toEqual(['出土地点'])
  })

  test('没有 must_cite 字段的话不该被抓出来', () => {
    expect(extractCitedValues('你站在这儿，能想象当年考生的样子吗？')).toEqual([])
  })
})

describe('一、值必须在证据里出现过（硬，拦捏造）', () => {
  test('说的年代证据里有，放行', () => {
    expect(checkCitations('江南贡院是南宋乾道四年建的', EVIDENCE).ok).toBe(true)
  })

  test('说的年代证据里没有，判为无依据', () => {
    const got = checkCitations('江南贡院是北宋景德三年建的', EVIDENCE)
    expect(got.ok).toBe(false)
    expect(got.violations).toContainEqual({
      rule: 'unsupported_value', label: '年代', value: '北宋景德三年',
    })
  })

  test('全角数字与多余空格归一化后仍算命中', () => {
    expect(checkCitations('也就是１１６８ 年', EVIDENCE).ok).toBe(true)
  })

  test('一条证据都没有时说年代，同样无依据——这正是该降级为「不确定」的时刻', () => {
    expect(checkCitations('江南贡院是1168年建的', []).ok).toBe(false)
  })

  test('不含 must_cite 字段的回答永远放行，哪怕没有证据', () => {
    expect(checkCitations('这地方值得慢慢逛，你先随便看看？', []).ok).toBe(true)
  })
})

describe('二、值得挂对主语（软，拦张冠李戴）', () => {
  test('线上实测的那次错：把贡院的年代说成明远楼的另一种说法', () => {
    const bad = '明远楼的始建年代资料里说法不一，有说南宋乾道四年，也有说明永乐年间。'
    const got = checkCitations(bad, EVIDENCE)
    expect(got.violations).toContainEqual({
      rule: 'misattributed_value', label: '年代', value: '南宋乾道四年',
    })
    // 明永乐年间是明远楼的，不该被一起判掉
    expect(got.violations.map((v) => v.value)).not.toContain('明永乐年间')
  })

  test('同样两个年代，分清楚了就放行', () => {
    const good = '明远楼始建于明永乐年间，清道光年间重建过。'
      + '不过它跟江南贡院整体不是一回事，贡院早到南宋乾道四年就建了。'
    expect(checkCitations(good, EVIDENCE).violations).toEqual([])
  })

  test('省略主语的口语不算硬伤：只报 misattributed，不报 unsupported', () => {
    const colloquial = '这座楼是明永乐年间建的。'
    const got = checkCitations(colloquial, EVIDENCE)
    expect(got.violations.every((v) => v.rule === 'misattributed_value')).toBe(true)
  })

  test('值本身就没依据时不重复报 misattributed——一条值只报一次', () => {
    const got = checkCitations('明远楼是北宋景德三年建的', EVIDENCE)
    expect(got.violations.filter((v) => v.value === '北宋景德三年')).toHaveLength(1)
  })
})

describe('打回重写时告诉模型哪几条没依据', () => {
  test('把违规的值原样列出来，并给出降级说法', () => {
    const suffix = buildCiteRewriteSuffix([
      { rule: 'unsupported_value', label: '年代', value: '北宋景德三年' },
    ], 120)
    expect(suffix).toContain('北宋景德三年')
    expect(suffix).toMatch(/不确定|没有把握|查不到/)
    expect(suffix).toContain('120')
  })

  test('没有违规时不产生后缀', () => {
    expect(buildCiteRewriteSuffix([], 120)).toBe('')
  })
})
