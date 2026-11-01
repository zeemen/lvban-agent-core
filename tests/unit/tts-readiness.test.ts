import { describe, expect, test } from 'vitest'
import type { Filler } from '../../src/content/fillers.js'
import { loadFillers } from '../../src/content/fillers.js'
import { loadAnchors, type Anchor } from '../../src/content/loader.js'
import type { ManifestEntry } from '../../src/tts/manifest.js'
import { presynthPlan } from '../../src/tts/plan.js'
import { itemState, readinessReport, type AudioReadiness } from '../../src/tts/readiness.js'

/**
 * 预合成音频的启动核对。
 *
 * 为什么每条都要有反例：这套判定的失败方式是「什么都不报」。核对写错了，
 * 启动日志上看见的「全部就绪」和真的全部就绪长得一模一样——而线上表现
 * 只是垫音不出声，没人会联想到这里。
 */

const fillerOf = (id: string, audioKey: string): Filler => ({
  id, situation: 'question', text: '让我看看。', audioKey, register: 'peer',
})

const anchorOf = (patch: {
  readonly anchorId: string
  readonly isTop30: boolean
  readonly hooks?: { companion: string | null; child: string | null; light: string | null }
}): Anchor => ({
  anchorId: patch.anchorId,
  name: '测试锚点',
  sceneId: 'fuzimiao',
  poiId: patch.anchorId,
  exhibitId: undefined,
  isTop30: patch.isTop30,
  topics: [],
  review: { status: 'draft', reviewedBy: [], reviewedAt: null, factCheckRequired: [] },
  k1Sources: [{ title: '测试来源' }],
  elements: {
    openingHook: patch.hooks ?? { companion: '你看这个。', child: '你看呀。', light: '这是某物。' },
    observation: { companion: null, child: null, light: null },
    question: { companion: null, child: null, light: null },
    explanation: { companion: null, child: null, light: null },
    story: null,
    connection: { curriculum: null, presentDay: null },
    memoryLink: { template: '你上次在{place}问过{topic}。' },
    nextAction: { suggest: null, reason: '测试' },
  },
})

const entryOf = (patch: Partial<ManifestEntry> = {}): ManifestEntry => ({
  provider: 'tencent', voice: '101016', speedRatio: 1, text: '让我看看。',
  bytes: 100, durationMs: 500, createdAt: '2026-11-01T00:00:00.000Z', ...patch,
})

const want = { provider: 'tencent', voice: '101016', speedRatio: 1, text: '让我看看。' }

describe('预合成清单由 presynthPlan 一处说了算', () => {
  test('垫音每条一项，标成 filler', () => {
    const plan = presynthPlan([fillerOf('f1', 'fillers/peer_q_01.mp3')], new Map())

    expect(plan).toEqual([{
      kind: 'filler', audioKey: 'fillers/peer_q_01.mp3', text: '让我看看。',
      register: 'peer', label: 'f1',
    }])
  })

  test('Top30 锚点的开场段按三种口吻各一条', () => {
    const a = anchorOf({ anchorId: 'fzm_a', isTop30: true })

    const keys = presynthPlan([], new Map([['fzm_a', a]])).map((i) => i.audioKey)

    expect(keys).toEqual([
      'anchors/fzm_a.companion.mp3', 'anchors/fzm_a.child.mp3', 'anchors/fzm_a.light.mp3',
    ])
  })

  test('不是 Top30 的锚点不预合成 —— 预合成是给高频点位省延迟的', () => {
    const a = anchorOf({ anchorId: 'fzm_b', isTop30: false })

    expect(presynthPlan([], new Map([['fzm_b', a]]))).toEqual([])
  })

  test('开场段是空的那一路跳过，不会排出一条合不出来的任务', () => {
    const a = anchorOf({
      anchorId: 'fzm_c', isTop30: true,
      hooks: { companion: '你看这个。', child: null, light: '' },
    })

    expect(presynthPlan([], new Map([['fzm_c', a]])).map((i) => i.audioKey))
      .toEqual(['anchors/fzm_c.companion.mp3'])
  })

  test('真实内容：每条垫音都在清单里', async () => {
    const fillers = await loadFillers()

    const keys = presynthPlan(fillers, await loadAnchors()).map((i) => i.audioKey)

    expect(fillers.length).toBeGreaterThan(0)
    for (const f of fillers) expect(keys).toContain(f.audioKey)
  })
})

describe('单条音频的状态判定', () => {
  test('文件不在：missing', () => {
    expect(itemState(false, entryOf(), want).state).toBe('missing')
  })

  /*
   * 这一条是整套检查真正的理由。manifest.ts 的注释写明了这个坑：
   * 用 mock 预合成过一轮之后换上真供应商，presynth 会因为文件已存在而
   * 全部跳过——线上播的就是假音频，而且不报错。
   */
  test('文件在但是用别的供应商合的：stale，而且说得出差在哪', () => {
    const result = itemState(true, entryOf({ provider: 'mock' }), want)

    expect(result.state).toBe('stale')
    expect(result.reason).toContain('供应商变了')
  })

  test('文件在但音色换了：stale', () => {
    expect(itemState(true, entryOf({ voice: '999999' }), want).state).toBe('stale')
  })

  test('文件在但文案改了：stale', () => {
    expect(itemState(true, entryOf({ text: '旧的台词。' }), want).state).toBe('stale')
  })

  test('文件在、清单里却没有记录：stale，不能当成就绪', () => {
    expect(itemState(true, undefined, want).state).toBe('stale')
  })

  test('全都对得上：ok', () => {
    expect(itemState(true, entryOf(), want)).toEqual({ state: 'ok', reason: '' })
  })
})

describe('启动日志说人话', () => {
  const gaps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ audioKey: `k${i}`, label: `l${i}`, reason: '缺' }))

  const readiness = (patch: Partial<AudioReadiness> = {}): AudioReadiness => ({
    provider: 'mock', expected: 10, missing: [], stale: [], ...patch,
  })

  test('全就绪：info，一行', () => {
    const r = readinessReport(readiness())

    expect(r.level).toBe('info')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toContain('10/10')
  })

  test('只是缺文件：warn', () => {
    expect(readinessReport(readiness({ missing: gaps(2) })).level).toBe('warn')
  })

  test('有音色对不上的：抬到 error —— 那是在播错的东西，比缺更难发现', () => {
    expect(readinessReport(readiness({ stale: gaps(1) })).level).toBe('error')
    expect(readinessReport(readiness({ missing: gaps(9), stale: gaps(1) })).level).toBe('error')
  })

  test('最多列 5 条，剩下的报个数 —— 启动日志不是清单', () => {
    const lines = readinessReport(readiness({ expected: 30, missing: gaps(12) })).lines

    expect(lines.filter((l) => l.includes('（k'))).toHaveLength(5)
    expect(lines.some((l) => l.includes('另有 7 条'))).toBe(true)
  })

  test('有缺口时一定告诉你跑哪条命令', () => {
    const lines = readinessReport(readiness({ missing: gaps(1) })).lines

    expect(lines.join('\n')).toContain('node --run tts:presynth')
  })
})
