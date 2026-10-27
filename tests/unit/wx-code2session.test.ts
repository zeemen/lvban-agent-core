import { afterEach, describe, expect, test, vi } from 'vitest'
import { WxAuthError, code2Session } from '../../src/auth/wx.js'

/**
 * code2Session 契约测试。
 * 依据官方文档 developers.weixin.qq.com/miniprogram/dev/server/API/user-login/
 * api_code2session.html（页面标注最后编辑于 2026-07-04）。
 */

const CREDS = { appId: 'wx_test_appid', appSecret: 's3cr3t-app-secret' }

const stub = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => { vi.unstubAllGlobals() })

const urlOf = (fetchMock: ReturnType<typeof vi.fn>): URL =>
  new URL(String(fetchMock.mock.calls[0]?.[0]))

describe('请求构造', () => {
  test('按文档拼 GET /sns/jscode2session，四个查询参数齐全', async () => {
    const fetchMock = stub({ openid: 'o_123', session_key: 'sk' })

    await code2Session('the-code', CREDS)

    const url = urlOf(fetchMock)
    expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session')
    expect(url.searchParams.get('appid')).toBe('wx_test_appid')
    expect(url.searchParams.get('secret')).toBe('s3cr3t-app-secret')
    expect(url.searchParams.get('js_code')).toBe('the-code')
    expect(url.searchParams.get('grant_type')).toBe('authorization_code')
  })
})

describe('成功响应', () => {
  test('返回 openid 与 unionid', async () => {
    stub({ openid: 'o_123', unionid: 'u_456', session_key: 'sk' })

    const session = await code2Session('c', CREDS)

    expect(session.openid).toBe('o_123')
    expect(session.unionid).toBe('u_456')
  })

  test('不把 session_key 透出去：本产品只取 openid，不解密手机号（PRD U01）', async () => {
    stub({ openid: 'o_123', session_key: 'must-not-leak' })

    const session = await code2Session('c', CREDS)

    expect(JSON.stringify(session)).not.toContain('must-not-leak')
    expect(JSON.stringify(session)).not.toContain('session_key')
  })

  test('errcode 为 0 是成功——文档的成功示例里就带着 errcode: 0', async () => {
    stub({ openid: 'o_123', session_key: 'sk', errcode: 0, errmsg: 'ok' })

    await expect(code2Session('c', CREDS)).resolves.toMatchObject({ openid: 'o_123' })
  })

  test('没有 unionid 时为 undefined，而不是报错（未绑开放平台时就没有）', async () => {
    stub({ openid: 'o_123', session_key: 'sk' })

    expect((await code2Session('c', CREDS)).unionid).toBeUndefined()
  })
})

describe('错误码映射', () => {
  const cases = [
    { errcode: 40029, kind: 'invalid_code', status: 401, retryable: false },
    { errcode: 40226, kind: 'blocked', status: 403, retryable: false },
    { errcode: 45011, kind: 'rate_limited', status: 429, retryable: true },
    { errcode: -1, kind: 'upstream_busy', status: 503, retryable: true },
  ] as const

  for (const { errcode, kind, status, retryable } of cases) {
    test(`errcode ${errcode} → ${kind}（HTTP ${status}）`, async () => {
      stub({ errcode, errmsg: 'from wechat' })

      const error = await code2Session('c', CREDS).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(WxAuthError)
      expect((error as WxAuthError).kind).toBe(kind)
      expect((error as WxAuthError).httpStatus).toBe(status)
      expect((error as WxAuthError).retryable).toBe(retryable)
    })
  }

  test('appid 填错（40013）是配置问题，不能报成「微信不可用」', async () => {
    stub({ errcode: 40013, errmsg: 'invalid appid' })

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    expect((error as WxAuthError).kind).toBe('invalid_config')
    expect((error as WxAuthError).message).toContain('WX_APPID')
  })

  test('appsecret 填错（40125）同样归为配置问题', async () => {
    stub({ errcode: 40125, errmsg: 'invalid appsecret' })

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    expect((error as WxAuthError).kind).toBe('invalid_config')
    expect((error as WxAuthError).message).toContain('WX_APPSECRET')
  })

  test('未知 errcode 不当成功，归为 upstream_error', async () => {
    stub({ errcode: 41001, errmsg: 'access_token missing' })

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    expect((error as WxAuthError).kind).toBe('upstream_error')
  })

  test('没有 errcode 也没有 openid 时必须报错，不能返回空身份', async () => {
    stub({ session_key: 'sk' })

    await expect(code2Session('c', CREDS)).rejects.toBeInstanceOf(WxAuthError)
  })
})

describe('传输层故障', () => {
  test('HTTP 非 2xx 归为 upstream_error', async () => {
    stub('<html>502</html>', 502)

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    expect((error as WxAuthError).kind).toBe('upstream_error')
  })

  test('网络异常归为 network 且可重试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    expect((error as WxAuthError).kind).toBe('network')
    expect((error as WxAuthError).retryable).toBe(true)
  })
})

describe('密钥保护', () => {
  test('appSecret 不出现在任何错误信息里——错误会进日志', async () => {
    stub({ errcode: 40029, errmsg: 'invalid code' })

    const error = await code2Session('c', CREDS).catch((e: unknown) => e)

    const dumped = `${(error as Error).message}${JSON.stringify(error)}${(error as Error).stack ?? ''}`
    expect(dumped).not.toContain('s3cr3t-app-secret')
  })
})
