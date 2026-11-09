import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildSearchBody, isConfigured, judgeSearchResponse, parseKbMap, parsePassages,
  resolveKbIds, retrievePassages, searchRequest, searchUrl,
} from '../../src/knowledge/weknora.js'

/**
 * K3 长尾检索 —— 规格 03 §5 证据链第三级。
 *
 * 这一层的全部设计都压在两条实测结论上（2026-10-29，本地 WeKnora v0.8.3-152，
 * 两个知识库共 38 个 chunk）：
 *
 * 1. 混合检索与纯向量检索永远返回东西。拿「量子计算机怎么编程」去问夫子庙库，
 *    向量路径照样回 5 条 0.165–0.188 的 chunk；纯 BM25 回 0 条。
 *    规格 03 §5.3 要求「查不到就说不确定」，所以能说出「我没有」的只有 BM25。
 *    （这道门是漏的：写成「量子计算机是怎么编程的？」就命中 5 条，虚词足以让它不空。
 *    最终兜底的是 prompt 的证据纪律，见 src/agent/prompt.ts。）
 * 2. 融合后的分数不能当相关性阈值用。只要 BM25 有任意命中，top-1 就被归一到 1.0——
 *    拿「今天停车场在哪」去问，top-1 也是 1.0。vector_threshold / keyword_threshold
 *    都拦不住它。所以分数只配排序，不配做门槛。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })

const hit = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  content: '江南贡院始建于南宋乾道四年（1168年）。',
  knowledge_id: 'k1',
  knowledge_title: 'kb-gongyuan.md',
  score: 1,
  ...over,
})

const client = {
  baseUrl: 'http://weknora.test:8080',
  apiKey: 'test-key',
  timeoutMs: 800,
  maxPassages: 3,
}

describe('这条响应算什么 —— 检索与自检共用的唯一判定', () => {
  /*
   * 这个判定以前没有直接用例，只被两条路径间接走到。它恰恰是最该钉死的东西：
   * 2026-11-08 那次故障之所以能活那么久，就是因为「被拒」滑进了「查不到」。
   * 每多一种被误判成「正常空结果」的形状，就多一次整月没人发现的机会。
   */
  test('有命中：hitCount 和可引用的条数分开报', () => {
    const got = judgeSearchResponse(200, {
      success: true,
      data: [hit({ id: 'c1' }), hit({ id: 'c2', content: '   ' })],
    })
    expect(got.kind).toBe('accepted')
    expect(got.kind === 'accepted' && got.hitCount).toBe(2)
    // 第二条内容是空白，引用不了 —— 通道通着不等于拿到了证据
    expect(got.kind === 'accepted' && got.passages.length).toBe(1)
  })

  test('data:null 是后端明确说「没有」→ accepted，零命中', () => {
    const got = judgeSearchResponse(200, { success: true, data: null })
    expect(got.kind).toBe('accepted')
    expect(got.kind === 'accepted' && got.hitCount).toBe(0)
  })

  test('缺 data 字段 → rejected。换了响应信封的新版本不许拿到免检通行证', () => {
    expect(judgeSearchResponse(200, { success: true }).kind).toBe('rejected')
  })

  test('换了字段名的信封 → rejected，不许把真命中悄悄丢掉', () => {
    expect(judgeSearchResponse(200, { code: 0, results: [hit()] }).kind).toBe('rejected')
  })

  test('顶层直接是数组 → rejected（typeof [] 也是 object）', () => {
    expect(judgeSearchResponse(200, [hit()]).kind).toBe('rejected')
  })

  test('data 既不是数组也不是 null → rejected', () => {
    expect(judgeSearchResponse(200, { success: true, data: { a: 1 } }).kind).toBe('rejected')
  })

  test('error 直接给字符串时也要能把原话带出来', () => {
    const got = judgeSearchResponse(500, { success: false, error: 'boom' })
    expect(got.kind === 'rejected' && got.detail).toContain('boom')
  })

  test('被拒但没给 error 时，不要拼出一个尾巴上挂着冒号的句子', () => {
    const got = judgeSearchResponse(500, { success: false })
    expect(got.kind === 'rejected' && got.detail).not.toContain('：')
  })

  test('2xx 不只有 200：201 带正常 data 要算 accepted', () => {
    expect(judgeSearchResponse(201, { success: true, data: [hit()] }).kind).toBe('accepted')
  })

  test('data:[null] 这种脏数据不许抛，按零可引用处理', () => {
    const got = judgeSearchResponse(200, { success: true, data: [null] })
    expect(got.kind).toBe('accepted')
    expect(got.kind === 'accepted' && got.passages).toEqual([])
  })
})

describe('「配好了吗」只判一处', () => {
  test('三个条件缺一个都算没配', () => {
    expect(isConfigured(client, { fuzimiao: 'a' })).toBe(true)
    expect(isConfigured({ ...client, baseUrl: '' }, { fuzimiao: 'a' })).toBe(false)
    expect(isConfigured({ ...client, apiKey: '' }, { fuzimiao: 'a' })).toBe(false)
    expect(isConfigured(client, {})).toBe(false)
  })
})

describe('检索地址只拼一次', () => {
  /*
   * 这个路径原先在两处各拼一遍（检索一处、启动自检一处）。
   * 同一条规则写两遍，迟早变成两个地址：自检探通了而检索打在别处，
   * 或者反过来，而现场只会更难查。
   */
  test('路径由一处给出，检索与自检共用', () => {
    expect(searchUrl(client, 'aaa'))
      .toBe('http://weknora.test:8080/api/v1/knowledge-bases/aaa/hybrid-search')
  })
})

describe('检索请求的形状', () => {
  test('关掉向量召回——它永远有答案，就没法说「我没有」', () => {
    expect(buildSearchBody({ query: '号舍', limit: 3, kbIds: ['a'] }))
      .toMatchObject({ disable_vector_match: true })
  })

  test('跳过上下文扩展：行中只要能引用的那一段，不要父子块', () => {
    expect(buildSearchBody({ query: '号舍', limit: 3, kbIds: ['a'] }))
      .toMatchObject({ skip_context_enrichment: true, match_count: 3, query_text: '号舍' })
  })

  test('跨库检索时才带 knowledge_base_ids，单库不带——少一个字段少一处分歧', () => {
    expect(buildSearchBody({ query: '号舍', limit: 3, kbIds: ['a'] }))
      .not.toHaveProperty('knowledge_base_ids')
    expect(buildSearchBody({ query: '号舍', limit: 3, kbIds: ['a', 'b'] }))
      .toMatchObject({ knowledge_base_ids: ['a', 'b'] })
  })
})

describe('响应解析', () => {
  test('取出正文、来源标题与分数', () => {
    expect(parsePassages({ success: true, data: [hit()] })).toEqual([{
      chunkId: 'c1',
      knowledgeId: 'k1',
      title: 'kb-gongyuan.md',
      text: '江南贡院始建于南宋乾道四年（1168年）。',
      score: 1,
    }])
  })

  test('空正文直接丢掉：拿它去填证据只会凭空多一条来源', () => {
    expect(parsePassages({ success: true, data: [hit({ content: '  ' })] })).toEqual([])
  })

  test('没有命中就是没有——这正是「不确定」该触发的信号', () => {
    expect(parsePassages({ success: true, data: [] })).toEqual([])
  })

  test('形状不认识时当作没检索到，而不是抛出去打断回答', () => {
    expect(parsePassages({ success: false })).toEqual([])
    expect(parsePassages(null)).toEqual([])
    expect(parsePassages({ data: '不是数组' })).toEqual([])
  })

  test('缺标题时退回文档 ID，不留空白来源', () => {
    expect(parsePassages({ data: [hit({ knowledge_title: '' })] })[0]?.title).toBe('k1')
  })
})

describe('知识库映射', () => {
  test('按场景解析 "场景=库ID" 列表', () => {
    expect(parseKbMap('fuzimiao=aaa,njmuseum=bbb')).toEqual({ fuzimiao: 'aaa', njmuseum: 'bbb' })
  })

  test('空串、空白项、缺等号的项一律忽略，不让半截配置变成假库 ID', () => {
    expect(parseKbMap('')).toEqual({})
    expect(parseKbMap('fuzimiao=aaa, ,bad,=x,y=')).toEqual({ fuzimiao: 'aaa' })
  })

  test('知道在哪个场景就只搜那个库', () => {
    expect(resolveKbIds({ fuzimiao: 'aaa', njmuseum: 'bbb' }, 'fuzimiao')).toEqual(['aaa'])
  })

  test('不知道场景就全搜——用户站在哪不该决定他能不能问', () => {
    expect([...resolveKbIds({ fuzimiao: 'aaa', njmuseum: 'bbb' }, null)].sort())
      .toEqual(['aaa', 'bbb'])
    expect(resolveKbIds({ fuzimiao: 'aaa' }, '没配过的场景')).toEqual(['aaa'])
  })
})

describe('取证据这件事不许打断回答', () => {
  test('没配 baseUrl / apiKey 就安静地不检索', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const got = await retrievePassages(
      { query: '号舍', sceneId: 'fuzimiao' },
      { ...client, apiKey: '' }, { fuzimiao: 'aaa' },
    )
    expect(got).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('一个库都没配时同样不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await retrievePassages({ query: '号舍', sceneId: null }, client, {})).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('检索服务 500 了，回答照常进行，只是没有 K3 证据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    expect(await retrievePassages({ query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
  })

  test('超时同理：语音优先，宁可少一条引用也不能卡住这句话', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout))
    expect(await retrievePassages({ query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
  })

  test('响应不是 JSON 也不抛', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })))
    expect(await retrievePassages({ query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
  })

  /*
   * 2026-11-08 实测踩到的那条缝：WeKnora 在部分部署下把失败写成 HTTP 200 + success:false
   * （Tencent/WeKnora#4899）。旧代码过了 response.ok 这道门，又因为 data 不是数组而
   * 返回空集——于是「后端拒了我们的请求体」和「库里确实没有」在日志里长得一模一样。
   * 查不到要照常回答且不必报警；被拒必须留下痕迹，否则这条链路可以整月是死的而没人知道。
   */
  test('200 但 success=false：是被拒，不是查不到，必须记一条', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { message: 'ERROR: Unsupported query shape.' } }),
      { status: 200 },
    )))

    expect(await retrievePassages({ query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('Unsupported query shape')
  })

  test('真查不到（success:true、data 空）不报警 —— 那是正常结果，不是故障', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok([])))
    expect(await retrievePassages({ query: '量子计算机', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('实际调用', () => {
  /*
   * 没有锚点时 sceneId 是 null（respond.ts 里是 `anchor?.sceneId ?? null`），
   * 于是 resolveKbIds 返回整张表，请求体多带一个 knowledge_base_ids。
   * 「随口问一句」走的就是这个形状，而且比站在点位上问更常见——
   * 以前没有任何用例钉过它，启动自检也只探单库形状，两边同时漏。
   */
  test('没有锚点时发的是跨库形状：路径取第一个库，请求体带上全部', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([hit()]))
    vi.stubGlobal('fetch', fetchMock)

    await retrievePassages(
      { query: '乡试考几天', sceneId: null }, client, { fuzimiao: 'aaa', njmuseum: 'bbb' },
    )

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://weknora.test:8080/api/v1/knowledge-bases/aaa/hybrid-search')
    expect(JSON.parse(String(init.body))).toMatchObject({
      knowledge_base_ids: ['aaa', 'bbb'], disable_vector_match: true,
    })
  })

  test('整个请求由 searchRequest 发出，检索与自检没有第二份拼法', () => {
    const [url, init] = searchRequest(client, {
      query: '号舍', kbIds: ['aaa', 'bbb'], timeoutMs: 5000,
    })
    expect(url).toBe('http://weknora.test:8080/api/v1/knowledge-bases/aaa/hybrid-search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key')
    expect(JSON.parse(String(init.body))).toMatchObject({ knowledge_base_ids: ['aaa', 'bbb'] })
  })

  /*
   * 「回了东西但一条都引用不了」必须留痕：和「库里确实没有」一样空手而归，
   * 但原因完全不同——后端或语料出了问题，而不是这个问题恰好没资料。
   */
  test('命中了但内容全是空：返回空集，并且要报一声', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok([hit({ content: '  ' })])))

    expect(await retrievePassages({ query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'a' }))
      .toEqual([])
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toContain('命中 1 条')
  })

  test('打到该场景的库上，带 X-API-Key，截到 maxPassages 条', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([
      hit({ id: 'c1' }), hit({ id: 'c2' }), hit({ id: 'c3' }), hit({ id: 'c4' }),
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const got = await retrievePassages(
      { query: '号舍', sceneId: 'fuzimiao' }, client, { fuzimiao: 'aaa', njmuseum: 'bbb' },
    )

    expect(got.map((p) => p.chunkId)).toEqual(['c1', 'c2', 'c3'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://weknora.test:8080/api/v1/knowledge-bases/aaa/hybrid-search')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key')
    expect(JSON.parse(init.body as string)).toMatchObject({
      query_text: '号舍', disable_vector_match: true,
    })
  })
})
