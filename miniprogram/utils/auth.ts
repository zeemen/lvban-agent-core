/**
 * 小程序登录态。
 *
 * 流程：wx.login 拿一次性 code → 服务端 /v1/auth/wx-login 用 code2Session
 * 换 openid 并签发会话令牌 → 令牌存本地，之后每个请求带 Authorization。
 *
 * 两条硬约束决定了这里的写法：
 *   1. code 一次性、约 5 分钟过期。所以 wx.login 只在真要登录时调，
 *      不在 onLoad 预取——预取的 code 等用户点下按钮时多半已经废了（errcode 40029）。
 *   2. appSecret 只能在服务端。小程序永远拿不到 openid 之外的东西。
 *
 * 依赖全部注入，所以整套流程能在 Node 里测，不必每次都开模拟器。
 */

const STORAGE_KEY = 'lvban_session'

export type Session = {
  readonly userId: string
  readonly token: string
}

export type LoginResult = Session & {
  readonly expiresIn: number
  readonly isNew: boolean
}

export type StorageLike = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  remove(key: string): void
}

export type SessionStore = {
  read(): Session | null
  write(session: Session): void
  clear(): void
}

/** 残缺数据按「未登录」处理：带着半个会话上路只会在后面某个请求上莫名 401 */
const isSession = (value: unknown): value is Session => {
  if (typeof value !== 'object' || value === null) return false
  const { userId, token } = value as { userId?: unknown; token?: unknown }
  return typeof userId === 'string' && userId !== ''
    && typeof token === 'string' && token !== ''
}

export const createSessionStore = (storage: StorageLike): SessionStore => ({
  read(): Session | null {
    try {
      const raw = storage.get(STORAGE_KEY)
      return isSession(raw) ? { userId: raw.userId, token: raw.token } : null
    } catch {
      // 存储异常不该让登录直接崩，退化成「未登录」重新走一遍即可
      return null
    }
  },
  write(session: Session): void {
    storage.set(STORAGE_KEY, session)
  },
  clear(): void {
    try { storage.remove(STORAGE_KEY) } catch { /* 清不掉也不影响重新登录 */ }
  },
})

/** 默认用 wx 的同步存储；注入点留给测试 */
export const wxStorage = (): StorageLike => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.wx?.getStorageSync === undefined) {
    throw new Error('不在小程序环境中：请注入 storage 实现')
  }
  return {
    get: (key) => g.wx.getStorageSync(key),
    set: (key, value) => { g.wx.setStorageSync(key, value) },
    remove: (key) => { g.wx.removeStorageSync(key) },
  }
}

export const wxLoginCode = async (): Promise<string> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.wx?.login === undefined) {
    throw new Error('不在小程序环境中：请注入 wxLogin 实现')
  }
  return new Promise<string>((resolve, reject) => {
    g.wx.login({
      success: (res: { code?: string }) => {
        if (res.code === undefined || res.code === '') {
          reject(new Error('wx.login 没有返回 code'))
          return
        }
        resolve(res.code)
      },
      fail: (err: { errMsg?: string }) => { reject(new Error(err.errMsg ?? 'wx.login 失败')) },
    })
  })
}

export type LoginDeps = {
  wxLogin(): Promise<string>
  exchange(code: string): Promise<LoginResult>
  store: SessionStore
}

/** 同一时刻只允许一次登录在飞：并发调用会共享同一个 code，否则第二个必然 40029 */
let inflight: Promise<Session> | null = null

export const ensureSession = async (
  deps: LoginDeps, options: { forceRelogin?: boolean } = {},
): Promise<Session> => {
  if (options.forceRelogin === true) {
    deps.store.clear()
    inflight = null
  } else {
    const cached = deps.store.read()
    if (cached !== null) return cached
    if (inflight !== null) return inflight
  }

  const run = (async (): Promise<Session> => {
    let code: string
    try {
      code = await deps.wxLogin()
    } catch (error) {
      throw new Error(`微信登录失败：${(error as Error).message}`)
    }

    const result = await deps.exchange(code)
    const session: Session = { userId: result.userId, token: result.token }
    deps.store.write(session)
    return session
  })()

  inflight = run
  try {
    return await run
  } finally {
    if (inflight === run) inflight = null
  }
}

/** 测试与「切换账号」用：清掉进行中的登录，避免复用上一次的 Promise */
export const resetInflightLogin = (): void => { inflight = null }

export type LoginBackend = {
  wxLogin(code: string): Promise<LoginResult>
  createDevUser(openid: string): Promise<{ userId: string; token: string }>
}

const statusOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const { statusCode } = error as { statusCode?: unknown }
  return typeof statusCode === 'number' ? statusCode : undefined
}

/**
 * 换票，带本地联调回落。
 *
 * 服务端没配 WX_APPSECRET 时 /v1/auth/wx-login 回 503，此时走 dev 接口拿身份，
 * 这样没有小程序密钥也能把整条链路跑完。
 * **只在 503 回落**：401（code 失效）和 403 是真实的登录失败，
 * 悄悄换成 dev 用户会把问题藏到下一次真机测试才暴露。
 */
export const createExchange = (
  backend: LoginBackend, devOpenId: string,
) => async (code: string): Promise<LoginResult> => {
  try {
    return await backend.wxLogin(code)
  } catch (error) {
    if (statusOf(error) !== 503) throw error
    try {
      const dev = await backend.createDevUser(devOpenId)
      return { userId: dev.userId, token: dev.token, expiresIn: 0, isNew: false }
    } catch {
      // 抛微信那边的原错：它说明了缺什么配置，dev 的 404 没有诊断价值
      throw error
    }
  }
}
