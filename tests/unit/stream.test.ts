import { afterEach, describe, expect, test, vi } from 'vitest'
import { streamSse, type StreamEvent } from '../../src/models/stream.js'

/** SSE 解析 —— 推理模型先流思维链、后流正文，两者必须分开 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const sseResponse = (chunks: readonly string[], status = 200): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

const collect = async (chunks: readonly string[]): Promise<readonly StreamEvent[]> => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(chunks)))
  const out: StreamEvent[] = []
  for await (const event of streamSse({
    url: 'https://example.test/v1/chat/completions',
    apiKey: 'k', body: {}, timeoutMs: 5_000, provider: 'test',
  })) out.push(event)
  return out
}

const dataLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const delta = (d: unknown): string => dataLine({ choices: [{ delta: d }] })

describe('streamSse', () => {
  test('正文增量按顺序吐出', async () => {
    const events = await collect([
      delta({ content: '你好' }), delta({ content: '，世界' }), 'data: [DONE]\n\n',
    ])

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text))
      .toEqual(['你好', '，世界'])
  })

  test('思维链与正文分成不同事件类型', async () => {
    const events = await collect([
      delta({ reasoning_content: '让我想想' }),
      delta({ content: '答案是' }),
      'data: [DONE]\n\n',
    ])

    expect(events.map((e) => e.type)).toEqual(['reasoning', 'delta', 'done'])
  })

  test('一个 data 行跨多个网络分片时仍能解析', async () => {
    const line = delta({ content: '被切开的内容' })
    const cut = Math.floor(line.length / 2)

    const events = await collect([line.slice(0, cut), line.slice(cut), 'data: [DONE]\n\n'])

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text))
      .toEqual(['被切开的内容'])
  })

  test('中间分片的 usage 为 null 时不崩 —— DeepSeek 实际就这么发', async () => {
    const events = await collect([
      dataLine({ choices: [{ delta: { content: '正文' } }], usage: null }),
      dataLine({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
      'data: [DONE]\n\n',
    ])

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ tokensIn: 10, tokensOut: 20 })
  })

  test('usage 里的 reasoning_tokens 被记下来', async () => {
    const events = await collect([
      dataLine({
        choices: [],
        usage: {
          prompt_tokens: 5, completion_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
      'data: [DONE]\n\n',
    ])

    expect(events.find((e) => e.type === 'done')).toMatchObject({ reasoningTokens: 30 })
  })

  test('单个坏分片被跳过，不让整段回答失败', async () => {
    const events = await collect([
      delta({ content: '前半' }),
      'data: {这不是合法 JSON}\n\n',
      delta({ content: '后半' }),
      'data: [DONE]\n\n',
    ])

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text))
      .toEqual(['前半', '后半'])
  })

  test('空的 content 增量不产生事件', async () => {
    const events = await collect([delta({ content: '' }), 'data: [DONE]\n\n'])

    expect(events.filter((e) => e.type === 'delta')).toHaveLength(0)
  })

  test('流结束一定有 done 事件', async () => {
    const events = await collect([delta({ content: '只有正文没有 DONE' })])

    expect(events[events.length - 1]?.type).toBe('done')
  })

  test('HTTP 错误按状态码分类', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      sseResponse(['{"error":{"message":"bad key"}}'], 401),
    ))

    const iterate = async (): Promise<void> => {
      for await (const _ of streamSse({
        url: 'https://example.test/v1/chat/completions',
        apiKey: 'k', body: {}, timeoutMs: 5_000, provider: 'test',
      })) void _
    }

    await expect(iterate()).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  test('超时被分类为 timeout', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout))

    const iterate = async (): Promise<void> => {
      for await (const _ of streamSse({
        url: 'https://example.test/v1/chat/completions',
        apiKey: 'k', body: {}, timeoutMs: 10, provider: 'test',
      })) void _
    }

    await expect(iterate()).rejects.toMatchObject({ kind: 'timeout' })
  })
})
