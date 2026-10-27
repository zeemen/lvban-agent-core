import { z } from 'zod'

/**
 * 微信小程序登录凭证校验（code2Session）。
 *
 * 文档核实要点（developers.weixin.qq.com/miniprogram/dev/server/API/user-login/
 * api_code2session.html，页面标注最后编辑于 2026-07-04）：
 *   - GET https://api.weixin.qq.com/sns/jscode2session
 *     查询参数 appid / secret / js_code / grant_type=authorization_code
 *   - 返回 openid、session_key、unionid（已绑开放平台才有）、errcode、errmsg
 *   - **成功响应里也可能带 errcode: 0**（文档的返回示例就是），
 *     所以不能用「有 errcode 就是失败」判断，必须判非 0
 *   - 错误码只有四个：-1 系统繁忙 / 40029 code 无效 /
 *     40226 高风险用户被拦截 / 45011 分钟级调用超限
 *   - 文档明写此接口只能服务端调用，appSecret 不得下发到小程序
 *
 * session_key 刻意不往外传：PRD U01 规定「仅取 openid，不索取手机号」，
 * 不解密任何加密数据就不需要持有它，少存一个凭证少一处泄漏面。
 */

const ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session'
const TIMEOUT_MS = 5_000

export type WxAuthErrorKind =
  | 'invalid_code'    // 40029：code 过期或被用过，客户端应重新 wx.login
  | 'blocked'         // 40226：高风险用户，微信侧拦截
  | 'rate_limited'    // 45011：分钟级配额
  | 'upstream_busy'   // -1：微信系统繁忙
  | 'invalid_config'  // 40013/40125：appid 或 appsecret 填错，是我们这边的配置问题
  | 'upstream_error'  // 其余 errcode、非 2xx、响应结构不对
  | 'network'         // 连不上、超时

export class WxAuthError extends Error {
  readonly kind: WxAuthErrorKind
  readonly httpStatus: number
  readonly retryable: boolean
  readonly errcode?: number

  constructor(kind: WxAuthErrorKind, message: string, errcode?: number) {
    super(message)
    this.name = 'WxAuthError'
    this.kind = kind
    this.errcode = errcode
    this.httpStatus = HTTP_STATUS[kind]
    this.retryable = RETRYABLE.has(kind)
  }
}

const HTTP_STATUS: Record<WxAuthErrorKind, number> = {
  invalid_code: 401,
  blocked: 403,
  rate_limited: 429,
  upstream_busy: 503,
  invalid_config: 500,
  upstream_error: 502,
  network: 503,
}

const RETRYABLE = new Set<WxAuthErrorKind>(['rate_limited', 'upstream_busy', 'network'])

const KIND_BY_ERRCODE: Record<number, WxAuthErrorKind> = {
  [-1]: 'upstream_busy',
  40029: 'invalid_code',
  40226: 'blocked',
  45011: 'rate_limited',
  // 下面两个不在本接口的错误码表里，属于「通用错误码」。
  // 真实打过一次才发现：appid 填错回的是 40013，
  // 若归到 upstream_error 就会报成「微信不可用」，把配置错误指向外部系统。
  40013: 'invalid_config',
  40125: 'invalid_config',
}

/** 配置错要直接说该改哪个环境变量，否则只能拿着 errcode 去翻文档 */
const CONFIG_HINT: Record<number, string> = {
  40013: '检查 WX_APPID 是否与小程序后台一致',
  40125: '检查 WX_APPSECRET 是否与小程序后台一致（重置过密钥要同步更新）',
}

/** errcode/errmsg 用 passthrough：微信加字段时不该把成功响应判成结构错误 */
const responseSchema = z.object({
  openid: z.string().optional(),
  unionid: z.string().optional(),
  session_key: z.string().optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
}).passthrough()

export type WxCredentials = {
  readonly appId: string
  readonly appSecret: string
}

/** 刻意不含 session_key */
export type WxSession = {
  readonly openid: string
  readonly unionid?: string
}

export const code2Session = async (
  code: string, creds: WxCredentials,
): Promise<WxSession> => {
  const url = new URL(ENDPOINT)
  url.searchParams.set('appid', creds.appId)
  url.searchParams.set('secret', creds.appSecret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // 刻意不带 url：它的查询串里有 appSecret，而错误会进日志
    const detail = error instanceof Error ? error.message : String(error)
    throw new WxAuthError('network', `调用微信 code2Session 失败：${detail}`)
  }

  if (!response.ok) {
    throw new WxAuthError('upstream_error', `微信 code2Session 返回 HTTP ${response.status}`)
  }

  const parsed = responseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new WxAuthError('upstream_error', '微信 code2Session 响应结构无法解析')
  }
  const body = parsed.data

  // 成功响应也可能带 errcode: 0，只有非 0 才是失败
  if (body.errcode !== undefined && body.errcode !== 0) {
    const kind = KIND_BY_ERRCODE[body.errcode] ?? 'upstream_error'
    const hint = CONFIG_HINT[body.errcode]
    throw new WxAuthError(
      kind,
      `微信 code2Session 返回 errcode ${body.errcode}：${body.errmsg ?? '无错误描述'}` +
        (hint === undefined ? '' : `。${hint}`),
      body.errcode,
    )
  }

  if (body.openid === undefined || body.openid === '') {
    throw new WxAuthError('upstream_error', '微信 code2Session 未返回 openid，拒绝建立空身份')
  }

  return { openid: body.openid, unionid: body.unionid }
}
