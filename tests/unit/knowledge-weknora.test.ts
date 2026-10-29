import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildSearchBody, parseKbMap, parsePassages, resolveKbIds, retrievePassages,
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
})

describe('实际调用', () => {
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
