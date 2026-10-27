/**
 * 鉴权开关。
 *
 * 读运行时 env 而不是启动时快照：开关要能在测试里逐用例切换，
 * 也便于线上临时降级时重启即生效。
 *
 * 默认值跟着 WX_APPSECRET 走——配了密钥说明真实登录可用，就该强制鉴权；
 * 本地联调没有密钥，保持现状不挡路。显式设 AUTH_REQUIRED 可以覆盖。
 */
export const isAuthRequired = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const explicit = env.AUTH_REQUIRED
  if (explicit === 'true') return true
  if (explicit === 'false') return false
  return (env.WX_APPSECRET ?? '') !== ''
}

export type WxConfig = { readonly appId: string; readonly appSecret: string }

/** 缺哪个说哪个：空密钥打微信只会拿到一个难以归因的 errcode */
export const requireWxConfig = (env: NodeJS.ProcessEnv = process.env): WxConfig => {
  const appId = env.WX_APPID ?? ''
  const appSecret = env.WX_APPSECRET ?? ''
  const missing = [
    appId === '' ? 'WX_APPID' : null,
    appSecret === '' ? 'WX_APPSECRET' : null,
  ].filter((name): name is string => name !== null)

  if (missing.length > 0) {
    throw new WxConfigMissing(
      `微信登录未配置：缺少 ${missing.join('、')}（小程序后台 → 开发管理 → 开发设置）`,
    )
  }
  return { appId, appSecret }
}

export class WxConfigMissing extends Error {
  readonly httpStatus = 503
  constructor(message: string) {
    super(message)
    this.name = 'WxConfigMissing'
  }
}
