import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMockTts } from '../../src/tts/mock.js'
import { createVolcengineTts } from '../../src/tts/volcengine.js'
import { cacheKey } from '../../src/tts/cache.js'
import { resolveVoice, usingPlaceholderVoice } from '../../src/tts/voices.js'
import { ttsAvailability } from '../../src/tts/availability.js'

/** 火山引擎 TTS —— 协议细节都是会静默失败的那种，必须锁死 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const okResponse = (overrides: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({
    reqid: 'r1', code: 3000, message: 'Success', sequence: -1,
    data: Buffer.from('fake-audio').toString('base64'),
    addition: { duration: '1960' },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } })

const stub = (res: Response) => {
  const fetchMock = vi.fn().mockResolvedValue(res)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const adapter = () => createVolcengineTts({ appId: 'app123', accessToken: 'tok456' })

const bodyOf = (m: ReturnType<typeof vi.fn>): Record<string, any> =>
  JSON.parse((m.mock.calls[0]?.[1] as { body: string }).body)

describe('火山引擎鉴权', () => {
  test('Authorization 用分号分隔，不是空格 —— 写成空格会鉴权失败', async () => {
    const fetchMock = stub(okResponse())

    await adapter().synthesize({ text: '测试', voice: 'BV001_streaming' })

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer;tok456')
    expect(headers.authorization).not.toContain('Bearer ')
  })

  test('请求体里的 app.token 是占位值，真鉴权在 header 上', async () => {
    const fetchMock = stub(okResponse())

    await adapter().synthesize({ text: '测试', voice: 'BV001_streaming' })

    const body = bodyOf(fetchMock)
    expect(body.app.appid).toBe('app123')
    expect(body.app.token).not.toBe('')
    expect(body.app.cluster).toBe('volcano_tts')
  })

  test('缺 appId 或 token 时创建适配器就报错', () => {
    expect(() => createVolcengineTts({ appId: '', accessToken: 't' }))
      .toThrow(/VOLC_TTS_APP_ID/)
  })
})

describe('请求体形状', () => {
  test('operation 必须是 query —— HTTP 只支持 query', async () => {
    const fetchMock = stub(okResponse())

    await adapter().synthesize({ text: '测试', voice: 'v1' })

    expect(bodyOf(fetchMock).request.operation).toBe('query')
  })

  test('每次请求的 reqid 都不同', async () => {
    // Response 的 body 只能读一次，所以每次调用要新建一个
    const fetchMock = vi.fn().mockImplementation(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const tts = adapter()

    await tts.synthesize({ text: '第一次', voice: 'v1' })
    await tts.synthesize({ text: '第二次', voice: 'v1' })

    const ids = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as { body: string }).body).request.reqid,
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  test('音色与语速按请求传入', async () => {
    const fetchMock = stub(okResponse())

    await adapter().synthesize({
      text: '测试', voice: 'zh_male_M392', speedRatio: 1.2, encoding: 'mp3',
    })

    const audio = bodyOf(fetchMock).audio
    expect(audio.voice_type).toBe('zh_male_M392')
    expect(audio.speed_ratio).toBe(1.2)
    expect(audio.encoding).toBe('mp3')
  })

  test('超长文本在发请求前就被拒绝，并提示要先分句', async () => {
    const fetchMock = stub(okResponse())

    await expect(adapter().synthesize({ text: '字'.repeat(400), voice: 'v1' }))
      .rejects.toThrow(/分句/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('响应处理', () => {
  test('base64 的 data 被解成音频字节', async () => {
    stub(okResponse())

    const result = await adapter().synthesize({ text: '测试', voice: 'v1' })

    expect(result.audio.toString()).toBe('fake-audio')
    expect(result.durationMs).toBe(1960)
  })

  test('HTTP 200 但 code 不是 3000 仍然算失败', async () => {
    stub(okResponse({ code: 3050, message: '音色不存在', data: undefined }))

    await expect(adapter().synthesize({ text: '测试', voice: 'bad_voice' }))
      .rejects.toThrow(/code=3050[\s\S]*音色不存在/)
  })

  test.each([
    [3003, 'server'],   // 并发超限，重试有用
    [3005, 'server'],   // 后端忙
    [3010, 'bad_request'], // 文本超限，改参数
    [3050, 'bad_request'], // 音色不存在
  ])('错误码 %i 归类为 %s', async (code, kind) => {
    stub(okResponse({ code, data: undefined }))

    await expect(adapter().synthesize({ text: '测试', voice: 'v1' }))
      .rejects.toMatchObject({ kind })
  })

  test('code 正确但没有音频数据时报错，不返回空 Buffer', async () => {
    stub(okResponse({ data: '' }))

    await expect(adapter().synthesize({ text: '测试', voice: 'v1' }))
      .rejects.toThrow(/没有返回音频/)
  })
})

describe('mock TTS', () => {
  test('按字数估算时长，供离线验证时序', async () => {
    const result = await createMockTts().synthesize({ text: '一二三四五', voice: 'v' })

    expect(result.durationMs).toBe(1000)
    expect(result.audio.byteLength).toBeGreaterThan(0)
  })
})

describe('cacheKey', () => {
  test('同样的文本与音色参数得到同一个 key', () => {
    const input = {
      provider: 'volcengine', voice: 'v1', text: '你好', encoding: 'mp3', speedRatio: 1,
    }

    expect(cacheKey(input)).toBe(cacheKey({ ...input }))
  })

  test.each([
    ['文本', { text: '不一样' }],
    ['音色', { voice: 'v2' }],
    ['语速', { speedRatio: 1.2 }],
    ['编码', { encoding: 'wav' }],
    ['供应商', { provider: 'other' }],
  ])('%s 变了就是新 key，不会读到旧音频', (_label, patch) => {
    const base = {
      provider: 'volcengine', voice: 'v1', text: '你好', encoding: 'mp3', speedRatio: 1,
    }

    expect(cacheKey({ ...base, ...patch })).not.toBe(cacheKey(base))
  })
})

describe('音色解析', () => {
  test('三种口吻各有独立的环境变量', () => {
    const env = { TTS_VOICE_PEER: 'a', TTS_VOICE_CHILD: 'b', TTS_VOICE_LIGHT: 'c' }

    expect(resolveVoice('peer', 'tencent', env).voice).toBe('a')
    expect(resolveVoice('storyteller', 'tencent', env).voice).toBe('b')
    expect(resolveVoice('concise', 'tencent', env).voice).toBe('c')
  })

  test('占位音色随供应商不同 —— 腾讯是整数 ID，火山是字符串代号', () => {
    expect(resolveVoice('peer', 'tencent', {}).voice).toBe('101001')
    expect(resolveVoice('peer', 'volcengine', {}).voice).toBe('BV001_streaming')
  })

  test('用了占位音色能被检测出来提醒替换', () => {
    expect(usingPlaceholderVoice('peer', 'tencent', {})).toBe(true)
    expect(usingPlaceholderVoice('peer', 'tencent', { TTS_VOICE_PEER: '601000' })).toBe(false)
  })

  test('语速可单独覆盖', () => {
    expect(resolveVoice('peer', 'tencent', { TTS_VOICE_PEER_SPEED: '1.3' }).speedRatio)
      .toBe(1.3)
  })
})

describe('ttsAvailability', () => {
  test('mock 永远可用，保证离线链路跑得通', () => {
    expect(ttsAvailability({ TTS_PROVIDER: 'mock' })).toMatchObject({ available: true })
  })

  test('选了火山但没配 appid/token 时判为不可用，并说清缺什么', () => {
    const verdict = ttsAvailability({ TTS_PROVIDER: 'volcengine' })

    expect(verdict.available).toBe(false)
    if (!verdict.available) expect(verdict.reason).toContain('VOLC_TTS_APP_ID')
  })

  test('配齐后判为可用', () => {
    expect(ttsAvailability({
      TTS_PROVIDER: 'volcengine', VOLC_TTS_APP_ID: 'a', VOLC_TTS_ACCESS_TOKEN: 't',
    })).toMatchObject({ available: true, provider: 'volcengine' })
  })

  test('未知供应商判为不可用', () => {
    expect(ttsAvailability({ TTS_PROVIDER: 'nope' })).toMatchObject({ available: false })
  })
})
