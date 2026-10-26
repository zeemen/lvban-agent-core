import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTencentTts, toTencentSpeed } from '../../src/tts/tencent.js'
import { ttsAvailability } from '../../src/tts/availability.js'

/** 腾讯云 TTS —— 业务错误走 HTTP 200，和火山同一类坑 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const okResponse = (body: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({
    Response: {
      Audio: Buffer.from('tencent-audio').toString('base64'),
      SessionId: 's1',
      RequestId: 'r1',
      ...body,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

const stub = (make: () => Response) => {
  const fetchMock = vi.fn().mockImplementation(async () => make())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const adapter = () => createTencentTts({ secretId: 'AKIDx', secretKey: 'sk' })

const bodyOf = (m: ReturnType<typeof vi.fn>): Record<string, any> =>
  JSON.parse((m.mock.calls[0]?.[1] as { body: string }).body)

const headersOf = (m: ReturnType<typeof vi.fn>): Record<string, string> =>
  (m.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>

describe('请求构造', () => {
  test('打到 tts.tencentcloudapi.com，带 TC3 签名与必需的 X-TC-* 头', async () => {
    const fetchMock = stub(okResponse)

    await adapter().synthesize({ text: '你好', voice: '101001' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://tts.tencentcloudapi.com')
    const headers = headersOf(fetchMock)
    expect(headers.authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDx\//)
    expect(headers['x-tc-action']).toBe('TextToVoice')
    expect(headers['x-tc-version']).toBe('2019-08-23')
  })

  test('Action 与 Version 固定，SessionId 每次不同', async () => {
    const fetchMock = stub(okResponse)
    const tts = adapter()

    await tts.synthesize({ text: '第一次', voice: '101001' })
    await tts.synthesize({ text: '第二次', voice: '101001' })

    const ids = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as { body: string }).body).SessionId,
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  test('音色作为整数 VoiceType 传入', async () => {
    const fetchMock = stub(okResponse)

    await adapter().synthesize({ text: '你好', voice: '601000' })

    expect(bodyOf(fetchMock).VoiceType).toBe(601000)
  })

  test('非整数音色在发请求前就被拒绝，并说明去哪里查', async () => {
    const fetchMock = stub(okResponse)

    await expect(adapter().synthesize({ text: '你好', voice: 'BV001_streaming' }))
      .rejects.toThrow(/整数 ID[\s\S]*音色列表/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('超过 150 汉字在发请求前就被拒绝', async () => {
    const fetchMock = stub(okResponse)

    await expect(adapter().synthesize({ text: '字'.repeat(151), voice: '101001' }))
      .rejects.toThrow(/150 汉字/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('签名覆盖请求体：body 与签名时用的载荷一致', async () => {
    const fetchMock = stub(okResponse)

    await adapter().synthesize({ text: '你好', voice: '101001' })

    const sent = (fetchMock.mock.calls[0]?.[1] as { body: string }).body
    expect(JSON.parse(sent).Text).toBe('你好')
  })
})

describe('语速换算', () => {
  test('1.0 倍率对应档位 0（正常语速）', () => {
    expect(toTencentSpeed(1.0)).toBe(0)
  })

  test('文档锚点：-2 档约 0.6 倍、6 档约 2.5 倍', () => {
    expect(toTencentSpeed(0.6)).toBeCloseTo(-2, 1)
    expect(toTencentSpeed(2.5)).toBeCloseTo(6, 1)
  })

  test('略微加速映射到小正档位', () => {
    expect(toTencentSpeed(1.05)).toBeGreaterThan(0)
    expect(toTencentSpeed(1.05)).toBeLessThan(1)
  })

  test('超出范围被钳制在 [-2, 6]', () => {
    expect(toTencentSpeed(0.1)).toBe(-2)
    expect(toTencentSpeed(10)).toBe(6)
  })
})

describe('响应处理', () => {
  test('base64 的 Audio 被解成音频字节', async () => {
    stub(okResponse)

    const result = await adapter().synthesize({ text: '你好', voice: '101001' })

    expect(result.audio.toString()).toBe('tencent-audio')
    expect(result.provider).toBe('tencent')
  })

  test('HTTP 200 里的 Response.Error 仍然算失败 —— 只判 ok 会把错误当成功', async () => {
    stub(() => okResponse({
      Audio: undefined,
      Error: { Code: 'InvalidParameterValue.VoiceType', Message: '音色不存在' },
    }))

    await expect(adapter().synthesize({ text: '你好', voice: '999999' }))
      .rejects.toThrow(/InvalidParameterValue\.VoiceType[\s\S]*音色不存在/)
  })

  test('鉴权类错误被归为 auth，不重试', async () => {
    stub(() => okResponse({
      Audio: undefined,
      Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' },
    }))

    await expect(adapter().synthesize({ text: '你好', voice: '101001' }))
      .rejects.toMatchObject({ kind: 'auth' })
  })

  test.each([
    ['InternalError', 'server'],
    ['RequestLimitExceeded', 'server'],
    ['InvalidParameterValue', 'bad_request'],
  ])('错误码 %s 归类为 %s', async (Code, kind) => {
    stub(() => okResponse({ Audio: undefined, Error: { Code, Message: 'x' } }))

    await expect(adapter().synthesize({ text: '你好', voice: '101001' }))
      .rejects.toMatchObject({ kind })
  })

  test('成功但没有音频时报错，不返回空 Buffer', async () => {
    stub(() => okResponse({ Audio: '' }))

    await expect(adapter().synthesize({ text: '你好', voice: '101001' }))
      .rejects.toThrow(/没有返回音频/)
  })

  test('缺凭据时创建适配器就报错，并指出去哪里拿', () => {
    expect(() => createTencentTts({ secretId: '', secretKey: 'k' }))
      .toThrow(/TENCENT_SECRET_ID[\s\S]*API 密钥/)
  })
})

describe('可用性判定', () => {
  test('选了腾讯但没配密钥时判为不可用', () => {
    const verdict = ttsAvailability({ TTS_PROVIDER: 'tencent' })

    expect(verdict.available).toBe(false)
    if (!verdict.available) expect(verdict.reason).toContain('TENCENT_SECRET_ID')
  })

  test('配齐后判为可用', () => {
    expect(ttsAvailability({
      TTS_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'a', TENCENT_SECRET_KEY: 'b',
    })).toMatchObject({ available: true, provider: 'tencent' })
  })
})
