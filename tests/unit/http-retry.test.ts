import { afterEach, describe, expect, test, vi } from 'vitest'
import { ModelError, classifyHttpStatus, userFacingFallback } from '../../src/models/errors.js'
import { postJson } from '../../src/models/http.js'

/** 重试策略 —— 认证错误重试多少次都一样，限流和 5xx 才值得重试 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })

const call = () => postJson({
  url: 'https://example.test/v1/chat/completions',
  apiKey: 'k', body: {}, timeoutMs: 1_000, provider: 'test',
})

describe('classifyHttpStatus', () => {
  test.each([
    [401, 'auth'], [403, 'auth'], [429, 'rate_limit'],
    [400, 'bad_request'], [404, 'bad_request'], [422, 'bad_request'],
    [500, 'server'], [503, 'server'],
  ])('HTTP %i → %s', (status, kind) => {
    expect(classifyHttpStatus(status)).toBe(kind)
  })
})

describe('postJson 重试', () => {
  test('成功时不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await call()

    expect(result.attempts).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('401 不重试——Key 无效重试多少次都一样', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'invalid api key' } }, 401),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(call()).rejects.toThrow(ModelError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('429 会重试，最终成功', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await call()

    expect(result.attempts).toBe(2)
  })

  test('5xx 重试到上限后抛出最后一个错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'upstream down' } }, 503),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(call()).rejects.toMatchObject({ kind: 'server', status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('网络错误被分类为 network 并重试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(call()).rejects.toMatchObject({ kind: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('超时被分类为 timeout', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout))

    await expect(call()).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('供应商的错误消息被提取出来，而不是整个响应体', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Model not found: qwen-nope' } }, 404),
    ))

    await expect(call()).rejects.toThrow(/Model not found: qwen-nope/)
  })

  test('非 JSON 响应体被分类为 parse 错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    ))

    await expect(call()).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('userFacingFallback —— 规格 03 §5.3 禁止含糊其辞', () => {
  test('每种错误都有对用户说得出口的话', () => {
    const kinds = [
      'auth', 'rate_limit', 'timeout', 'network',
      'server', 'bad_request', 'content_filter', 'parse',
    ] as const

    for (const kind of kinds) {
      const text = userFacingFallback(kind)
      expect(text).not.toBe('')
      // 不能出现「可能…吧」这类既不承认不确定又给错误暗示的说法
      expect(text).not.toMatch(/可能.{0,10}吧|大概是/)
    }
  })
})
