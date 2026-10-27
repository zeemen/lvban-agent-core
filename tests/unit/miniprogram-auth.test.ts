import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createExchange, createSessionStore, ensureSession, type LoginDeps,
} from '../../miniprogram/utils/auth'

/**
 * 小程序登录流程。
 * 要点是 code 一次性且约 5 分钟过期：wx.login 必须在真正要登录时才调，
 * 不能在页面加载时先换好放着——这是社区里 40029 最常见的成因。
 */

const makeStorage = (): Record<string, unknown> => ({})

type Harness = {
  deps: LoginDeps
  state: { loginCalls: number; exchangeCalls: string[] }
}

const makeDeps = (overrides: Partial<LoginDeps> = {}): Harness => {
  const state = { loginCalls: 0, exchangeCalls: [] as string[] }
  const storage = makeStorage()
  const deps: LoginDeps = {
    wxLogin: async () => { state.loginCalls += 1; return `code_${state.loginCalls}` },
    exchange: async (code) => {
      state.exchangeCalls.push(code)
      return { userId: 'u_1', token: `token_for_${code}`, expiresIn: 2592000, isNew: true }
    },
    store: createSessionStore({
      get: (key) => storage[key],
      set: (key, value) => { storage[key] = value },
      remove: (key) => { delete storage[key] },
    }),
    ...overrides,
  }
  return { deps, state }
}

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.unstubAllGlobals() })

describe('首次登录', () => {
  test('换 code 拿令牌并落盘', async () => {
    const { deps, state } = makeDeps()

    const session = await ensureSession(deps)

    expect(session.userId).toBe('u_1')
    expect(session.token).toBe('token_for_code_1')
    expect(deps.store.read()?.token).toBe('token_for_code_1')
  })

  test('只调一次 wx.login：code 是一次性的', async () => {
    const { deps, state } = makeDeps()

    await ensureSession(deps)

    expect(state.loginCalls).toBe(1)
    expect(state.exchangeCalls).toEqual(['code_1'])
  })
})

describe('复用已有登录态', () => {
  test('已有令牌时不再调 wx.login', async () => {
    const { deps, state } = makeDeps()
    await ensureSession(deps)

    const again = await ensureSession(deps)

    expect(state.loginCalls).toBe(1)
    expect(again.token).toBe('token_for_code_1')
  })

  test('并发调用只登录一次，不会连打两次 code2session', async () => {
    const { deps, state } = makeDeps()

    const [a, b] = await Promise.all([ensureSession(deps), ensureSession(deps)])

    expect(state.loginCalls).toBe(1)
    expect(a.token).toBe(b.token)
  })

  test('forceRelogin 时丢弃旧令牌重新换一个（令牌过期后的恢复路径）', async () => {
    const { deps, state } = makeDeps()
    const first = await ensureSession(deps)

    const second = await ensureSession(deps, { forceRelogin: true })

    expect(second.token).not.toBe(first.token)
    expect(state.loginCalls).toBe(2)
  })
})

describe('失败处理', () => {
  test('wx.login 失败时给出可读错误，不返回空身份', async () => {
    const { deps, state } = makeDeps({ wxLogin: async () => { throw new Error('login:fail') } })

    await expect(ensureSession(deps)).rejects.toThrow(/微信登录失败/)
  })

  test('换票失败不会把坏令牌写进存储', async () => {
    const { deps, state } = makeDeps({ exchange: async () => { throw new Error('HTTP 401') } })

    await expect(ensureSession(deps)).rejects.toThrow()
    expect(deps.store.read()).toBeNull()
  })

  test('存储里是残缺数据时当作未登录，而不是带着半个会话上路', async () => {
    const storage: Record<string, unknown> = { lvban_session: { token: '' } }
    const { deps, state } = makeDeps({
      store: createSessionStore({
        get: (key) => storage[key],
        set: (key, value) => { storage[key] = value },
        remove: (key) => { delete storage[key] },
      }),
    })

    const session = await ensureSession(deps)

    expect(session.token).toBe('token_for_code_1')
  })
})

describe('退出', () => {
  test('clear 之后再登录会重新走 wx.login', async () => {
    const { deps, state } = makeDeps()
    await ensureSession(deps)

    deps.store.clear()
    await ensureSession(deps)

    expect(state.loginCalls).toBe(2)
  })
})

describe('本地联调回落', () => {
  const backend = (overrides: Partial<Parameters<typeof createExchange>[0]> = {}) => ({
    wxLogin: async () => ({ userId: 'u_wx', token: 't_wx', expiresIn: 1, isNew: true }),
    createDevUser: async () => ({ userId: 'u_dev', token: 't_dev' }),
    ...overrides,
  })

  test('服务端没配 appsecret（503）时回落到 dev 接口，本地联调不被挡住', async () => {
    const exchange = createExchange(
      backend({
        wxLogin: async () => { throw Object.assign(new Error('HTTP 503'), { statusCode: 503 }) },
      }),
      'dev_openid',
    )

    expect((await exchange('code')).userId).toBe('u_dev')
  })

  test('微信登录成功时不碰 dev 接口', async () => {
    let devCalls = 0
    const exchange = createExchange(
      backend({ createDevUser: async () => { devCalls += 1; return { userId: 'x', token: 'y' } } }),
      'dev_openid',
    )

    expect((await exchange('code')).userId).toBe('u_wx')
    expect(devCalls).toBe(0)
  })

  test('401 不回落：那是真实的登录失败，掩盖掉只会更难查', async () => {
    const exchange = createExchange(
      backend({
        wxLogin: async () => { throw Object.assign(new Error('HTTP 401'), { statusCode: 401 }) },
      }),
      'dev_openid',
    )

    await expect(exchange('code')).rejects.toThrow(/401/)
  })

  test('dev 接口也不可用时抛出微信那边的原始错误，而不是 dev 的', async () => {
    const exchange = createExchange(
      backend({
        wxLogin: async () => { throw Object.assign(new Error('HTTP 503 缺少 WX_APPSECRET'), { statusCode: 503 }) },
        createDevUser: async () => { throw new Error('HTTP 404') },
      }),
      'dev_openid',
    )

    await expect(exchange('code')).rejects.toThrow(/WX_APPSECRET/)
  })
})
