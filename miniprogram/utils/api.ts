import type { WireEvent } from '../shared/stream-events'
import { createUtf8StreamDecoder } from './utf8'
import { createSseParser, toWireEvent } from './sse'

/**
 * M2 接口的类型化客户端。
 *
 * 流式那条路是这里的难点：小程序没有 EventSource，只能用
 * wx.request({ enableChunked: true }) 配 RequestTask.onChunkReceived
 * （基础库 2.20.2+），拿到的是 ArrayBuffer 分片。
 * 分片 → UTF-8 → SSE 帧 → 类型化事件，四层都要能处理跨分片切断。
 *
 * request 做成可注入：整条流水线因此能在 Node 里用假分片测，
 * 不必每次改动都开模拟器。
 */

export type ChunkListener = (res: { data: ArrayBuffer }) => void

export type RequestTaskLike = {
  abort(): void
  onChunkReceived?(listener: ChunkListener): void
}

export type RequestOptions = {
  url: string
  method?: 'GET' | 'POST' | 'DELETE'
  data?: unknown
  header?: Record<string, string>
  enableChunked?: boolean
  timeout?: number
  success?(res: { statusCode: number; data: unknown }): void
  fail?(err: { errMsg: string }): void
}

export type RequestFn = (options: RequestOptions) => RequestTaskLike

export type ClientOptions = {
  readonly baseUrl: string
  /** 默认用 wx.request；测试时注入假实现 */
  readonly request?: RequestFn
  /**
   * 每次请求现取令牌，而不是建客户端时传入 ——
   * 登录发生在客户端创建之后，快照一份会一直发空头。
   */
  readonly getToken?: () => string | null
  /**
   * 收到 401 时重新登录，返回新令牌（拿不到则返回 null）。
   * 只重放一次：重登后仍 401 说明不是登录态的问题，再试就是打循环。
   */
  readonly onUnauthorized?: () => Promise<string | null>
}

export class ApiError extends Error {
  readonly statusCode: number
  constructor(statusCode: number, body: unknown) {
    super(`HTTP ${statusCode}：${JSON.stringify(body)}`)
    this.name = 'ApiError'
    this.statusCode = statusCode
  }
}

export type LoginResponse = {
  readonly userId: string
  readonly token: string
  readonly expiresIn: number
  readonly isNew: boolean
}

export type Journey = {
  readonly journeyId: string
  readonly state: string
  readonly trackConsent: string
}

export type ArriveResult = {
  readonly spoke: boolean
  readonly text: string | null
  readonly vetoedBy: string | null
  readonly proactivityReason: string
}

export type StreamHandlers = {
  onEvent(event: WireEvent): void
  onError?(message: string): void
  onComplete?(): void
}

export type StreamHandle = { abort(): void }

const defaultRequest = (): RequestFn => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.wx?.request === undefined) {
    throw new Error('不在小程序环境中：请注入 request 实现')
  }
  return g.wx.request.bind(g.wx) as RequestFn
}

export const createClient = (options: ClientOptions) => {
  const base = options.baseUrl.replace(/\/+$/, '')
  const request: RequestFn = options.request ?? defaultRequest()

  /**
   * 请求头。没有 body 时不能带 content-type：
   * 服务端会拒绝「声明了 JSON 却是空 body」的请求（这个坑只有真实网络测得出来）。
   */
  const headersFor = (data: unknown, token: string | null): Record<string, string> => {
    const header: Record<string, string> = {}
    if (data !== undefined) header['content-type'] = 'application/json'
    if (token !== null && token !== '') header['Authorization'] = `Bearer ${token}`
    return header
  }

  const once = <T>(
    path: string, method: 'GET' | 'POST' | 'DELETE', data: unknown, token: string | null,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      request({
        url: `${base}${path}`,
        method,
        data,
        header: headersFor(data, token),
        success(res) {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data as T)
          else reject(new ApiError(res.statusCode, res.data))
        },
        fail(err) {
          reject(new Error(err.errMsg))
        },
      })
    })

  const call = async <T>(
    path: string, method: 'GET' | 'POST' | 'DELETE', data?: unknown,
  ): Promise<T> => {
    const token = options.getToken?.() ?? null
    try {
      return await once<T>(path, method, data, token)
    } catch (error) {
      // 只有 401 是「登录态过期」。403 是越权，重登也没用，重放反而掩盖问题
      const expired = error instanceof ApiError && error.statusCode === 401
      if (!expired || options.onUnauthorized === undefined) throw error
      const fresh = await options.onUnauthorized()
      return once<T>(path, method, data, fresh)
    }
  }

  return {
    audioUrl(audioKey: string): string {
      return `${base}/v1/audio/${audioKey}`
    },

    /** 微信登录：用 wx.login 拿到的一次性 code 换会话令牌 */
    wxLogin(code: string): Promise<LoginResponse> {
      return call<LoginResponse>('/v1/auth/wx-login', 'POST', { code })
    },

    logout(): Promise<unknown> {
      return call('/v1/auth/logout', 'POST')
    },

    /**
     * 开发期建用户。没配 WX_APPSECRET 的本地环境用它拿一个稳定身份，
     * 服务端会一并签发令牌，所以联调和线上走的是同一套鉴权。
     * 服务端开启强制鉴权后这个接口返回 404。
     */
    createDevUser(openid: string): Promise<{ userId: string; token: string }> {
      return call<{ userId: string; token: string }>('/v1/dev/users', 'POST', { openid })
    },

    startJourney(input: {
      userId: string; mode: string; party: string
      sceneId: string; trackConsent: string
    }): Promise<Journey> {
      return call<Journey>('/v1/journeys', 'POST', input)
    },

    endJourney(journeyId: string): Promise<unknown> {
      return call(`/v1/journeys/${journeyId}/end`, 'POST')
    },

    deleteJourney(journeyId: string): Promise<unknown> {
      return call(`/v1/journeys/${journeyId}`, 'DELETE')
    },

    sendSignals(journeyId: string, points: readonly unknown[]): Promise<unknown> {
      return call(`/v1/journeys/${journeyId}/signals`, 'POST', { points })
    },

    arrive(journeyId: string, poiId: string): Promise<ArriveResult> {
      return call<ArriveResult>(`/v1/journeys/${journeyId}/arrive`, 'POST', { poiId })
    },

    /**
     * 流式提问。回调式而不是 Promise —— wx.request 本身就是回调式，
     * 而且调用方需要在第一个 filler 事件到达时立刻播音，不能等整体 resolve。
     */
    askStream(
      input: { journeyId: string; text: string; poiId?: string },
      handlers: StreamHandlers,
    ): StreamHandle {
      const decoder = createUtf8StreamDecoder()
      const parser = createSseParser()
      let finished = false

      const drain = (text: string): void => {
        for (const frame of parser.push(text)) {
          const event = toWireEvent(frame)
          if (event !== null) handlers.onEvent(event)
        }
      }

      const finish = (): void => {
        if (finished) return
        finished = true
        drain(decoder.flush())
        for (const frame of parser.flush()) {
          const event = toWireEvent(frame)
          if (event !== null) handlers.onEvent(event)
        }
        handlers.onComplete?.()
      }

      const task = request({
        url: `${base}/v1/journeys/${input.journeyId}/ask/stream`,
        method: 'POST',
        data: { text: input.text, poiId: input.poiId },
        header: headersFor({ text: input.text }, options.getToken?.() ?? null),
        enableChunked: true,
        success(res) {
          // 4xx/5xx 也会走 success（HTTP 请求本身完成了）。
          // 不看状态码的话，一个 401 会表现为「正常结束但一个事件都没有」
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (finished) return
            finished = true
            handlers.onError?.(`HTTP ${res.statusCode}：讲解请求被拒绝`)
            return
          }
          finish()
        },
        fail(err) {
          if (finished) return
          finished = true
          handlers.onError?.(err.errMsg)
        },
      })

      // 基础库低于 2.20.2 时没有这个方法：此时拿不到流式，要明确告知而不是静默无声
      if (task.onChunkReceived === undefined) {
        handlers.onError?.(
          '当前微信基础库不支持流式（需 2.20.2 以上），请升级微信后重试',
        )
        return { abort: () => task.abort() }
      }

      task.onChunkReceived((res) => {
        drain(decoder.push(res.data))
      })

      return {
        abort(): void {
          finished = true
          task.abort()
        },
      }
    },
  }
}

export type LvbanClient = ReturnType<typeof createClient>
