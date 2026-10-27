import { describe, expect, test } from 'vitest'
import { createClient, type RequestFn, type RequestOptions } from '../../miniprogram/utils/api'

/** 客户端携带令牌、以及令牌过期后的自愈 */

type Reply = { statusCode: number; data: unknown }

const recording = (replies: Reply[]): { request: RequestFn; calls: RequestOptions[] } => {
  const calls: RequestOptions[] = []
  const queue = [...replies]
  const request: RequestFn = (options) => {
    calls.push(options)
    const reply = queue.shift() ?? { statusCode: 200, data: {} }
    queueMicrotask(() => { options.success?.(reply) })
    return { abort: () => undefined, onChunkReceived() { /* 非流式用例用不到 */ } }
  }
  return { request, calls }
}

const authOf = (options: RequestOptions | undefined): string | undefined =>
  options?.header?.['Authorization']

describe('携带令牌', () => {
  test('有令牌时带 Authorization: Bearer', async () => {
    const { request, calls } = recording([{ statusCode: 200, data: { ok: true } }])
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => 'tok_1' })

    await client.endJourney('j_1')

    expect(authOf(calls[0])).toBe('Bearer tok_1')
  })

  test('没登录时不带 Authorization，让服务端按匿名处理', async () => {
    const { request, calls } = recording([{ statusCode: 200, data: {} }])
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => null })

    await client.endJourney('j_1')

    expect(authOf(calls[0])).toBeUndefined()
  })

  test('无 body 的请求仍然不带 content-type，但可以带 Authorization', async () => {
    const { request, calls } = recording([{ statusCode: 200, data: {} }])
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => 'tok_1' })

    await client.endJourney('j_1')

    expect(calls[0]?.header?.['content-type']).toBeUndefined()
    expect(authOf(calls[0])).toBe('Bearer tok_1')
  })

  test('令牌在登录后变化时取到的是新值（getToken 每次现取）', async () => {
    let token: string | null = null
    const { request, calls } = recording([
      { statusCode: 200, data: {} }, { statusCode: 200, data: {} },
    ])
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => token })

    await client.endJourney('j_1')
    token = 'tok_after_login'
    await client.endJourney('j_2')

    expect(authOf(calls[0])).toBeUndefined()
    expect(authOf(calls[1])).toBe('Bearer tok_after_login')
  })
})

describe('令牌过期自愈', () => {
  test('401 后重新登录并重放一次，调用方看不到这次抖动', async () => {
    const { request, calls } = recording([
      { statusCode: 401, data: { error: 'error' } },
      { statusCode: 200, data: { purged: true } },
    ])
    let token = 'stale'
    const client = createClient({
      baseUrl: 'http://x', request,
      getToken: () => token,
      onUnauthorized: async () => { token = 'fresh'; return token },
    })

    await expect(client.deleteJourney('j_1')).resolves.toMatchObject({ purged: true })

    expect(calls).toHaveLength(2)
    expect(authOf(calls[0])).toBe('Bearer stale')
    expect(authOf(calls[1])).toBe('Bearer fresh')
  })

  test('重登后仍 401 就不再重试，避免打循环', async () => {
    const { request, calls } = recording([
      { statusCode: 401, data: {} }, { statusCode: 401, data: {} }, { statusCode: 401, data: {} },
    ])
    const client = createClient({
      baseUrl: 'http://x', request,
      getToken: () => 'bad',
      onUnauthorized: async () => 'still-bad',
    })

    await expect(client.deleteJourney('j_1')).rejects.toThrow(/401/)
    expect(calls).toHaveLength(2)
  })

  test('没提供 onUnauthorized 时 401 直接抛出', async () => {
    const { request } = recording([{ statusCode: 401, data: {} }])
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => 'x' })

    await expect(client.deleteJourney('j_1')).rejects.toThrow(/401/)
  })

  test('403 不触发重登：那是越权，不是登录态问题', async () => {
    let relogins = 0
    const { request } = recording([{ statusCode: 403, data: {} }])
    const client = createClient({
      baseUrl: 'http://x', request,
      getToken: () => 'tok',
      onUnauthorized: async () => { relogins += 1; return 'new' },
    })

    await expect(client.deleteJourney('j_1')).rejects.toThrow(/403/)
    expect(relogins).toBe(0)
  })
})

describe('登录接口', () => {
  test('wxLogin 把 code 发到 /v1/auth/wx-login', async () => {
    const { request, calls } = recording([
      { statusCode: 200, data: { userId: 'u', token: 't', expiresIn: 1, isNew: true } },
    ])
    const client = createClient({ baseUrl: 'http://x', request })

    const result = await client.wxLogin('the-code')

    expect(calls[0]?.url).toBe('http://x/v1/auth/wx-login')
    expect(calls[0]?.data).toEqual({ code: 'the-code' })
    expect(result.token).toBe('t')
  })
})

describe('流式请求的状态码', () => {
  test('带上 Authorization', () => {
    const calls: RequestOptions[] = []
    const request: RequestFn = (options) => {
      calls.push(options)
      return { abort: () => undefined, onChunkReceived() { /* 不推分片 */ } }
    }
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => 'tok_s' })

    client.askStream({ journeyId: 'j', text: '问' }, { onEvent: () => undefined })

    expect(authOf(calls[0])).toBe('Bearer tok_s')
  })

  test('非 2xx 结束时报错，而不是静默当成「正常结束但一个事件都没有」', async () => {
    const request: RequestFn = (options) => {
      queueMicrotask(() => { options.success?.({ statusCode: 401, data: '' }) })
      return { abort: () => undefined, onChunkReceived() { /* 无分片 */ } }
    }
    const client = createClient({ baseUrl: 'http://x', request, getToken: () => 'tok' })

    const errors: string[] = []
    let completed = false
    client.askStream({ journeyId: 'j', text: '问' }, {
      onEvent: () => undefined,
      onError: (message) => { errors.push(message) },
      onComplete: () => { completed = true },
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })

    expect(errors[0]).toMatch(/401/)
    expect(completed).toBe(false)
  })
})
