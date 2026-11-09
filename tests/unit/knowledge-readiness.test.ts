import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkK3Readiness, classifyProbe, k3Report, probeTargets, probeTimeoutMs, PROBE_QUERIES,
} from '../../src/knowledge/readiness.js'

/**
 * K3 启动自检 —— 为什么需要它，由 2026-11-08 的一次实测决定。
 *
 * 那天 K3 整条是死的，而仓库里没有任何东西会说出来：
 *   一、`.env` 指的端口已经没人应答（容器映射从 8080 漂到 8180）。
 *   二、换到活的端口之后，代码那个纯 BM25 请求被后端以 HTTP 500 拒掉
 *       （Tencent/WeKnora#4899，v0.9.0 的回归）。
 * 863 条用例全绿，CI 全绿，因为所有 WeKnora 用例都 mock 掉了 fetch——
 * 没有一条用真实请求体打过真实后端。
 *
 * 所以自检的判据不是「后端活着吗」：那天后端活着，混合检索照回 200。
 * 判据必须是「**生产实际发的那些请求体**都被接受了吗」——注意是「那些」，
 * 复数。第一版自检只探单库形状就栽在这里，见下面 probeTargets 那一组。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const client = {
  baseUrl: 'http://weknora.test:8180',
  apiKey: 'test-key',
  timeoutMs: 800,
  maxPassages: 3,
}

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

/** 每次都要新建 Response：body 只能读一次，复用同一个对象第二次探测必失败 */
const always = (body: unknown, status = 200) =>
  vi.fn().mockImplementation(() => Promise.resolve(respond(body, status)))

describe('要探的是生产真的会发的那些形状', () => {
  /*
   * 这一组是第一版自检最大的漏洞所在，值得把来龙去脉写下来。
   *
   * 生产的 sceneId 来自锚点：`anchor?.sceneId ?? null`（respond.ts）。
   * 没有锚点时就是 null，而 resolveKbIds(map, null) 返回**整张表**，
   * 于是 buildSearchBody 会多带一个 knowledge_base_ids —— 这是跨库形状。
   * 「站在点位上问」是单库形状，「随口问一句」是跨库形状，后者还更常见。
   *
   * 第一版自检拿 `{ [sceneId]: kbId }` 这样一张单条目表去 resolveKbIds，
   * 结果恒等于 [kbId]，永远只探得到单库形状。而 #4899 是**查询计划**被拒，
   * 多一个跨库过滤条件恰恰是可能被另行规划的那种变化。
   * 也就是说：自检报「可检索」，而最常见的那个请求从没被试过。
   */
  test('每个场景一个单库形状', () => {
    expect(probeTargets({ fuzimiao: 'a', nanjing_museum: 'b' }).map((t) => t.kbIds))
      .toContainEqual(['a'])
    expect(probeTargets({ fuzimiao: 'a', nanjing_museum: 'b' }).map((t) => t.kbIds))
      .toContainEqual(['b'])
  })

  test('外加一个跨库形状 —— 没有锚点时生产发的就是它', () => {
    expect(probeTargets({ fuzimiao: 'a', nanjing_museum: 'b' }).map((t) => t.kbIds))
      .toContainEqual(['a', 'b'])
  })

  test('只配一个库时不重复探：跨库形状和单库形状本来就一样', () => {
    expect(probeTargets({ fuzimiao: 'a' })).toHaveLength(1)
  })

  test('一个库都没配就没得探', () => {
    expect(probeTargets({})).toEqual([])
  })
})

describe('单次探测的判定', () => {
  test('2xx 且有命中 → ok', () => {
    expect(classifyProbe(200, {
      success: true, data: [{ id: 'c1', content: '江南贡院始建于南宋。' }],
    }).state).toBe('ok')
  })

  test('2xx 但一条没中 → empty，不算故障：探针词本来可能不在这个库里', () => {
    expect(classifyProbe(200, { success: true, data: [] }).state).toBe('empty')
  })

  /*
   * 2026-11-08 实测，WeKnora 的「零命中」在线上是 data:null，不是空数组
   * （Go 侧 gorm.ErrRecordNotFound 直接 return nil, nil）。
   */
  test('data:null 且 success:true → empty。这是线上零命中的真实形状，不是被拒', () => {
    expect(classifyProbe(200, { success: true, data: null }).state).toBe('empty')
  })

  /*
   * 和 data:null 必须分开：null 是后端明确说「没有」，缺字段是我们看不懂的形状。
   * 把两者合并的那一版，等于给「换了响应信封的新版本」发了一张免检通行证。
   */
  test('根本没有 data 这个字段 → rejected，不许当成零命中', () => {
    expect(classifyProbe(200, { success: true }).state).toBe('rejected')
  })

  test('顶层直接是数组 → rejected：typeof [] 也是 object，不能让它混过去', () => {
    expect(classifyProbe(200, [{ id: 'c1' }]).state).toBe('rejected')
  })

  test('data 既不是数组也不是 null → rejected', () => {
    expect(classifyProbe(200, { success: true, data: {} }).state).toBe('rejected')
  })

  test('HTTP 500 → rejected，并把后端原话带出来', () => {
    const got = classifyProbe(500, {
      success: false,
      error: { code: 1007, message: 'ERROR: Unsupported query shape.' },
    })
    expect(got.state).toBe('rejected')
    expect(got.detail).toContain('Unsupported query shape')
  })

  test('200 但 success=false → 仍然是 rejected，不许混进「查不到」', () => {
    expect(classifyProbe(200, {
      success: false, error: { message: 'ERROR: Unsupported query shape.' },
    }).state).toBe('rejected')
  })

  test('200 但 body 整体不是对象 → rejected，而不是当成空结果', () => {
    expect(classifyProbe(200, 'not json at all').state).toBe('rejected')
  })

  /*
   * 「命中了但一条都引用不了」是独立的一档：通道通着，证据却是空的。
   * 报成 ok 会让人以为这一级在干活；报成「没中」又抹掉了「后端确实回了东西」。
   */
  test('命中了但内容全是空 → empty，并说清是不可引用而不是没命中', () => {
    const got = classifyProbe(200, { success: true, data: [{ id: 'c1', content: '   ' }] })
    expect(got.state).toBe('empty')
    expect(got.detail).toContain('不可引用')
  })
})

describe('探测的超时不跟检索共用', () => {
  /*
   * 2026-11-08 第一版自检接上去就踩到这个：真后端花了约 2 秒才把 500 送回来，
   * 而检索超时是 800ms（刻意的，语音不能等）。于是探测在知道真正原因之前就超时，
   * 被判成 unreachable，提示还去指端口——而端口那会儿是对的。
   * 一个把故障归错因的自检，比没有自检更费时间。
   */
  test('比检索超时宽：要等到后端把拒绝理由说完', () => {
    expect(probeTimeoutMs(800)).toBeGreaterThan(800)
  })

  /*
   * 也要封顶。第一版只有下限（Math.max），于是 WEKNORA_TIMEOUT_MS=30000
   * 会让自检串着等上几分钟才print那条谁都需要的 error ——
   * 一个诊断的全部价值在于被看见，等太久等于没有。
   */
  test('也封顶：自检是诊断，延迟到达的结论没有价值', () => {
    expect(probeTimeoutMs(30_000)).toBeLessThanOrEqual(10_000)
  })

  test('超时配成非数字时退回下限，而不是变成 NaN 立刻 abort', () => {
    expect(probeTimeoutMs(Number.NaN)).toBeGreaterThan(0)
  })
})

describe('整体核对', () => {
  test('没配 baseUrl / apiKey → configured false，一个探测都不发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await checkK3Readiness({ ...client, baseUrl: '' }, { fuzimiao: 'a' })
    expect(r.configured).toBe(false)
    expect(r.probes).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('跨库那次探测真的带上了 knowledge_base_ids', async () => {
    const fetchMock = always({ success: true, data: [{ id: 'c1', content: '甲' }] })
    vi.stubGlobal('fetch', fetchMock)

    await checkK3Readiness(client, { fuzimiao: 'a', nanjing_museum: 'b' })

    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>,
    )
    expect(bodies.some((b) => Array.isArray(b['knowledge_base_ids']))).toBe(true)
    expect(bodies.every((b) => PROBE_QUERIES.includes(String(b['query_text'])))).toBe(true)
    expect(bodies.every((b) => b['disable_vector_match'] === true)).toBe(true)
  })

  test('连不上 → unreachable，这是端口漂移那一类', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')))
    const r = await checkK3Readiness(client, { fuzimiao: 'a' })
    expect(r.probes.map((p) => p.state)).toEqual(['unreachable'])
    expect(r.probes.map((p) => p.detail).join('')).toContain('fetch failed')
  })

  /*
   * 后端回了 200 却带着我们解析不了的东西时，绝不能报成 unreachable。
   * 那条提示会让人去查端口和 docker ps，而后端其实好好地在应答——
   * 归错因正是这个文件要防的东西。
   */
  test('后端答了但内容有毒 → 不许报成「连不上」', async () => {
    vi.stubGlobal('fetch', always({ success: true, data: [null] }))
    const r = await checkK3Readiness(client, { fuzimiao: 'a' })
    expect(r.probes.map((p) => p.state)).not.toContain('unreachable')
  })

  test('探针词逐个试：前一个没中就换下一个，直到有结论', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(respond({ success: true, data: null })))
      .mockImplementationOnce(() => Promise.resolve(
        respond({ success: false, error: { message: 'boom' } }, 500)))
    vi.stubGlobal('fetch', fetchMock)

    const r = await checkK3Readiness(client, { fuzimiao: 'a' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(r.probes.map((p) => p.state)).toEqual(['rejected'])
  })

  test('所有探针词都不沾 → empty，并且不再多发请求', async () => {
    const fetchMock = always({ success: true, data: null })
    vi.stubGlobal('fetch', fetchMock)

    const r = await checkK3Readiness(client, { fuzimiao: 'a' })

    expect(r.probes.map((p) => p.state)).toEqual(['empty'])
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_QUERIES.length)
  })

  test('第一个词就有命中时，不浪费后面的请求', async () => {
    const fetchMock = always({ success: true, data: [{ id: 'c1', content: '甲' }] })
    vi.stubGlobal('fetch', fetchMock)

    const r = await checkK3Readiness(client, { fuzimiao: 'a' })

    expect(r.probes.map((p) => p.state)).toEqual(['ok'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('一个形状坏、一个好时，两条都要留下来', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve(Array.isArray(body['knowledge_base_ids'])
        ? respond({ success: false, error: { message: 'boom' } }, 500)
        : respond({ success: true, data: [{ id: 'c1', content: '甲' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await checkK3Readiness(client, { fuzimiao: 'a', nanjing_museum: 'b' })
    expect(r.probes.filter((p) => p.state === 'rejected')).toHaveLength(1)
    expect(r.probes.filter((p) => p.state === 'ok')).toHaveLength(2)
  })
})

describe('写成人话', () => {
  const probe = (over: Record<string, unknown> = {}) => ({
    label: 'fuzimiao', kbIds: ['a'], state: 'ok' as const, detail: '', ...over,
  })

  test('没配 → info，不是故障：产品允许没有 K3', () => {
    const got = k3Report({ configured: false, baseUrl: '', probes: [] })
    expect(got.level).toBe('info')
    expect(got.lines.join('\n')).toContain('未配置')
  })

  test('全 ok → info，并报出地址，省得又在错端口上查半天', () => {
    const got = k3Report({ configured: true, baseUrl: client.baseUrl, probes: [probe()] })
    expect(got.level).toBe('info')
    expect(got.lines.join('\n')).toContain(client.baseUrl)
  })

  test('有 rejected → error，且必须点名 disable_vector_match 和上游 issue', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: [probe({ state: 'rejected', detail: 'Unsupported query shape' })],
    })
    expect(got.level).toBe('error')
    const text = got.lines.join('\n')
    expect(text).toContain('disable_vector_match')
    expect(text).toContain('WeKnora#4899')
  })

  test('有 unreachable → error，且提示去核对 WEKNORA_BASE_URL', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: [probe({ state: 'unreachable', detail: 'fetch failed' })],
    })
    expect(got.level).toBe('error')
    expect(got.lines.join('\n')).toContain('WEKNORA_BASE_URL')
  })

  test('两种坏法同时出现时，两条提示都要给', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: [
        probe({ state: 'unreachable', detail: 'x' }),
        probe({ state: 'rejected', detail: 'y' }),
      ],
    })
    expect(got.lines.join('\n')).toContain('WEKNORA_BASE_URL')
    expect(got.lines.join('\n')).toContain('WeKnora#4899')
  })

  test('坏的形状超过 5 个时只列 5 个，剩下报个数 —— 启动日志不是清单', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: Array.from({ length: 7 }, (_, i) =>
        probe({ label: `s${i}`, state: 'rejected', detail: 'x' })),
    })
    expect(got.lines.join('\n')).toContain('另有 2 个')
  })

  test('头一行的「几个可检索」要把坏掉的排除掉', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: [probe(), probe({ state: 'rejected', detail: 'x' })],
    })
    expect(got.lines[0]).toContain('1/2')
  })

  /*
   * empty 不抬到 error：探针词不在某个库里是正常的。
   * 但也不能当没事——索引空了、库被清了，表现也是 empty。
   */
  test('只有 empty → warn，而且要说清这是「没能证明」而不是「没问题」', () => {
    const got = k3Report({
      configured: true, baseUrl: client.baseUrl, probes: [probe({ state: 'empty' })],
    })
    expect(got.level).toBe('warn')
    expect(got.lines.join('\n')).toContain('没能证明')
  })

  test('rejected 比 empty 严重，同时出现时按 error 报', () => {
    const got = k3Report({
      configured: true,
      baseUrl: client.baseUrl,
      probes: [probe({ state: 'empty' }), probe({ state: 'rejected', detail: 'x' })],
    })
    expect(got.level).toBe('error')
  })
})
