import { spawn } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { knownAnchorIds, lintAnchor, type Finding } from '../../src/content/lint.js'
import { loadAnchors, type Anchor } from '../../src/content/loader.js'

/**
 * 门禁自己的用例。
 *
 * 为什么值得单独测：lint 的两条新规则都是在查「这个 id 指不指得到东西」，
 * 而这件事上一次出错，是语料里 14 处写着规格表的行号。规则本身写错了的话，
 * 它只会安静地一条都不报——跑一遍 lint:content 看见「0 错误」，和规则没生效
 * 看见的「0 错误」长得一模一样。所以得有反例。
 */

/** 双签凭据的最小合法形态 —— 形状由 src/content/loader.ts 的 reviewSignerSchema 定 */
const signedReview: Anchor['review'] = {
  status: 'approved',
  reviewedBy: [
    { role: 'content_owner', account: 'owner@example.com' },
    { role: 'history_advisor', account: 'advisor@example.com' },
  ],
  reviewedAt: '2026-10-31',
  factCheckRequired: [],
}

/** 最小可用锚点。要素都填成合法值，这样测出来的只会是被测那一条规则 */
type Voiced = Anchor['elements']['openingHook']

const anchorOf = (patch: {
  readonly anchorId: string
  readonly poiId?: string
  readonly exhibitId?: string
  readonly suggest?: string | null
  readonly hook?: Voiced
  readonly explanation?: Voiced
}): Anchor => ({
  anchorId: patch.anchorId,
  name: '测试锚点',
  sceneId: 'fuzimiao',
  poiId: patch.poiId,
  exhibitId: patch.exhibitId,
  isTop30: false,
  topics: [],
  review: signedReview,
  k1Sources: [{ title: '测试来源' }],
  elements: {
    openingHook: patch.hook ?? { companion: '你看这个。', child: null, light: null },
    observation: { companion: null, child: null, light: null },
    question: { companion: null, child: null, light: null },
    explanation: patch.explanation ?? { companion: null, child: null, light: null },
    story: null,
    connection: { curriculum: null, presentDay: null },
    memoryLink: { template: '你上次在{place}问过{topic}。' },
    nextAction: { suggest: patch.suggest ?? null, reason: '测试' },
  },
})

const mapOf = (...list: readonly Anchor[]): ReadonlyMap<string, Anchor> =>
  new Map(list.map((a) => [a.anchorId, a]))

const rulesOf = (anchor: Anchor, map: ReadonlyMap<string, Anchor>): readonly string[] =>
  lintAnchor(anchor, map).map((f) => f.rule)

const findingOf = (
  anchor: Anchor, map: ReadonlyMap<string, Anchor>, rule: string,
): Finding | undefined => lintAnchor(anchor, map).find((f) => f.rule === rule)

describe('nextAction 指的下一站得真的存在', () => {
  test('指向一个不存在的 id：报警告', () => {
    const a = anchorOf({ anchorId: 'fzm_a', poiId: 'fzm_a_poi', suggest: 'fzm_nowhere' })

    expect(rulesOf(a, mapOf(a))).toContain('next_action/dangling')
  })

  test('指向另一个锚点的 anchorId：算对', () => {
    const target = anchorOf({ anchorId: 'fzm_b', poiId: 'fzm_b_poi' })
    const a = anchorOf({ anchorId: 'fzm_a', poiId: 'fzm_a_poi', suggest: 'fzm_b' })

    expect(rulesOf(a, mapOf(a, target))).not.toContain('next_action/dangling')
  })

  /*
   * 这一条是规格 04 §4.5 的实际写法：锚点 fzm_jiangnan_gongyuan_haoshe 的
   * nextAction 写的是点位 id fzm_mingyuan_lou，不是某个锚点的 anchorId。
   * 只认 anchorId 的规则会把这种正确写法判成指不到。
   */
  test('指向另一个锚点的点位 id：也算对', () => {
    const target = anchorOf({ anchorId: 'fzm_b_sub', poiId: 'fzm_b' })
    const a = anchorOf({ anchorId: 'fzm_a', poiId: 'fzm_a_poi', suggest: 'fzm_b' })

    expect(rulesOf(a, mapOf(a, target))).not.toContain('next_action/dangling')
  })

  test('留空：不报——没有下一站是正常状态，不是缺口', () => {
    const a = anchorOf({ anchorId: 'fzm_a', poiId: 'fzm_a_poi', suggest: null })

    expect(rulesOf(a, mapOf(a))).not.toContain('next_action/dangling')
  })
})

describe('语料「关联锚点」认的词表', () => {
  test('anchorId 与 poiId / exhibitId 都在词表里', () => {
    const map = mapOf(
      anchorOf({ anchorId: 'fzm_gongyuan_haoshe', poiId: 'fzm_gongyuan' }),
      anchorOf({ anchorId: 'njm_hu', exhibitId: 'njm_hu' }),
    )

    expect([...knownAnchorIds(map)].sort()).toEqual(
      ['fzm_gongyuan', 'fzm_gongyuan_haoshe', 'njm_hu'],
    )
  })

  test('真实内容里 fzm_jiangnan_gongyuan 在词表内 —— 它是号舍锚点的点位 id', async () => {
    const known = knownAnchorIds(await loadAnchors())

    expect(known).toContain('fzm_jiangnan_gongyuan')
    expect(known).toContain('fzm_jiangnan_gongyuan_haoshe')
  })
})

/*
 * 这一条查的是内容质量，所以反例比正例重要：规则写错了只会安静地一条
 * 都不报，而「0 警告」和「规则没生效」在门禁输出里长得一模一样。
 */
describe('开场钩子不要和讲解说同一句话', () => {
  const voiced = (light: string | null): Voiced => ({ companion: null, child: null, light })

  const pair = (hook: string | null, explanation: string | null): Anchor => anchorOf({
    anchorId: 'fzm_a',
    poiId: 'fzm_a_poi',
    hook: voiced(hook),
    explanation: voiced(explanation),
  })

  const ECHO = 'content/hook_echoes_explanation'

  /*
   * severity 要一起断言。这条规则的意义全在它拦不拦得住：报成 warn 的话
   * 上游 PR 的 CI 照样是绿的，警告只留在 run 日志里，没人点开看。
   */
  test('两句几乎一致：报错误，拦住上线', () => {
    const a = pair(
      '大成殿是夫子庙主殿，大殿七间，藏有反映孔子生平和教育思想的彩色壁画。',
      '大成殿是夫子庙主殿，大殿七间，藏有反映孔子生平和教育思想的彩色壁画，具体陈列以现场说明为准。',
    )

    expect(findingOf(a, mapOf(a), ECHO)?.severity).toBe('error')
  })

  test('钩子答「这是什么」、讲解答「凭什么值得看」：不报', () => {
    const a = pair(
      '这是一件战国时期的错金银工艺青铜壶。',
      '错金银工艺指在器物表面刻槽后嵌入金银丝并打磨齐平的装饰技法。',
    )

    expect(rulesOf(a, mapOf(a))).not.toContain(ECHO)
  })

  /*
   * 规格 04 §4.5 里 observation.light 与 question.light 本来就是 null，
   * 空栏是正常状态。把「没写」判成「重复」，是比漏报更费时间的误报。
   */
  test('一侧留空：不报', () => {
    const a = pair('这里是号舍。', null)

    expect(rulesOf(a, mapOf(a))).not.toContain(ECHO)
  })

  test('只有一个字的差别也算同一句 —— 标点不计', () => {
    const a = pair('乌衣巷位于秦淮河南岸。', '乌衣巷位于秦淮河南岸')

    expect(rulesOf(a, mapOf(a))).toContain(ECHO)
  })

  test('真实内容里 njm_cuojinyin_hu 不被报 —— 它是写对的那个样板', async () => {
    const anchors = await loadAnchors()
    const hu = anchors.get('njm_cuojinyin_hu')

    expect(hu).toBeDefined()
    expect(rulesOf(hu as Anchor, anchors)).not.toContain(ECHO)
  })
})

describe('真实锚点全过门禁', () => {
  /*
   * 这一条是把 severity 翻成 error 的前提：现存锚点必须一条都不报，
   * 否则门禁当天就红，而红的原因是历史欠账不是当次提交。
   * 它也顺带盯住后面 22 个锚点——谁再写出重复的一对，这里先红。
   */
  test('没有任何锚点的开场钩子与讲解说同一句话', async () => {
    const anchors = await loadAnchors()

    const echoes = [...anchors.values()]
      .flatMap((a) => lintAnchor(a, anchors))
      .filter((f) => f.rule === 'content/hook_echoes_explanation')

    expect(echoes).toEqual([])
  })

  test('四个锚点都没有 next_action/dangling', async () => {
    const anchors = await loadAnchors()

    const dangling = [...anchors.values()]
      .flatMap((a) => lintAnchor(a, anchors))
      .filter((f) => f.rule === 'next_action/dangling')

    expect(dangling).toEqual([])
  })
})

describe('门禁得能在没有服务、没有密钥的机器上跑', () => {
  /*
   * 为什么要起子进程测：这条性质在模块图上，不在任何一个函数里。
   *
   * 只要有人为了收尾方便 import 一下 db/pool，lint 就会连带 import config，
   * 而 config 缺 DATABASE_URL 时直接抛错。本机有 .env，谁都看不出来——
   * 到 CI 上才发现门禁连一行内容都还没看就先崩了。这正是 2026-10-31
   * 真实踩到的那一下。
   *
   * 中台按 git PR 交付（content/supply-chain-contract.md），门禁跑在
   * 没有 Postgres、Redis、WeKnora，也没有 .env 的 runner 上。
   */
  const runGate = (): Promise<{ readonly code: number; readonly out: string }> => {
    const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }
    delete env.DATABASE_URL
    delete env.REDIS_URL

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--run', 'lint:content'], { env })
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => { resolve({ code: code ?? -1, out }) })
    })
  }

  test('抹掉 DATABASE_URL 与 REDIS_URL，照样检查得完并退 0', async () => {
    const { code, out } = await runGate()

    expect(out).not.toContain('缺少必需的环境变量')
    expect(out).toMatch(/\[lint:content\] 检查 \d+ 个锚点、\d+ 篇语料/)
    expect(code).toBe(0)
  }, 60_000)
})
