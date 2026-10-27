import { config } from '../config'
import { createClient, type LvbanClient } from './api'
import {
  createExchange, createSessionStore, ensureSession,
  wxLoginCode, wxStorage, type LoginDeps, type Session, type SessionStore,
} from './auth'

/**
 * 全局唯一的客户端与登录依赖。
 *
 * 五个页面各自 new 一套的话，令牌刷新、并发登录去重都会各管各的——
 * ensureSession 的 in-flight 去重也就失效了。这里收成单例。
 */

let client: LvbanClient | null = null
let store: SessionStore | null = null
let deps: LoginDeps | null = null

const build = (): void => {
  store = createSessionStore(wxStorage())
  const created = createClient({
    baseUrl: config.baseUrl,
    // 现取而不是快照：登录发生在客户端创建之后
    getToken: () => store?.read()?.token ?? null,
    // 令牌过期后自动重登一次，用户无感
    onUnauthorized: async () => {
      if (deps === null) return null
      return (await ensureSession(deps, { forceRelogin: true })).token
    },
  })
  // 注意这里不调用 wx.login：code 一次性且约 5 分钟过期，
  // 预取的 code 等用户真要登录时多半已经废了（errcode 40029）
  deps = {
    wxLogin: wxLoginCode,
    exchange: createExchange(created, config.devOpenId),
    store,
  }
  client = created
}

export const getClient = (): LvbanClient => {
  if (client === null) build()
  return client as LvbanClient
}

/** 已登录就直接用，没登录才真的去换 code */
export const requireSession = async (): Promise<Session> => {
  if (deps === null) build()
  return ensureSession(deps as LoginDeps)
}

/** 当前登录态，不触发登录。首页用它决定显示「开始」还是「继续」 */
export const currentSession = (): Session | null => {
  if (store === null) build()
  return store?.read() ?? null
}

export const signOut = (): void => {
  store?.clear()
}
