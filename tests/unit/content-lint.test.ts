import { spawn } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { knownAnchorIds, lintAnchor } from '../../src/content/lint.js'
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
const anchorOf = (patch: {
  readonly anchorId: string
  readonly poiId?: string
  readonly exhibitId?: string
  readonly suggest?: string | null
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
    openingHook: { companion: '你看这个。', child: null, light: null },
    observation: { companion: null, child: null, light: null },
    question: { companion: null, child: null, light: null },
    explanation: { companion: null, child: null, light: null },
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

describe('真实锚点全过门禁', () => {
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
