import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { registerRoutes } from '../../src/http/routes.js'
import { createClient, type RequestFn } from '../../miniprogram/utils/api'
import type { WireEvent } from '../../miniprogram/shared/stream-events'
import { teardown } from '../helpers/db.js'

/**
 * 小程序客户端 × 真实服务端。
 *
 * 前面的用例用假分片测了解析流水线；这里用**真实 HTTP 分片**跑一遍，
 * 证明服务端实际发出的 SSE 字节能被小程序那套解析器还原。
 * 跨网络的契约对不上时，运行时只表现为「有时候没声音」，极难查——
 * 所以这条链路必须有一个真正过网络的测试。
 */

let app: FastifyInstance
let baseUrl = ''

beforeAll(async () => {
  app = Fastify()
  registerRoutes(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('拿不到监听端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app.close()
  await teardown()
})

/**
 * 用 fetch 的流式 body 模拟 wx.request 的 onChunkReceived。
 * 分片边界由操作系统和 Node 决定，不是我们挑的——这正是要验的东西。
 */
const fetchBackedRequest = (): RequestFn => (options) => {
  // 用持有对象而不是 let：下面是立即执行的 IIFE，TS 会把外层控制流带进去，
  // 把 let 窄化成 null，导致可选调用的非空分支成为 never
  const hook: { listener: ((res: { data: ArrayBuffer }) => void) | null } = { listener: null }
  const controller = new AbortController()

  void (async () => {
    try {
      const res = await fetch(options.url, {
        method: options.method ?? 'GET',
        headers: options.header,
        body: options.data === undefined ? undefined : JSON.stringify(options.data),
        signal: controller.signal,
      })

      if (options.enableChunked === true && res.body !== null) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) {
            hook.listener?.({
              data: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
            })
          }
        }
        options.success?.({ statusCode: res.status, data: '' })
        return
      }

      const text = await res.text()
      options.success?.({
        statusCode: res.status,
        data: text === '' ? '' : JSON.parse(text),
      })
    } catch (error) {
      options.fail?.({ errMsg: (error as Error).message })
    }
  })()

  return {
    abort: () => controller.abort(),
    onChunkReceived(cb) { hook.listener = cb },
  }
}

const makeClient = () => createClient({ baseUrl, request: fetchBackedRequest() })

const startJourney = async () => {
  const client = makeClient()
  const user = await client.createDevUser(`mp_e2e_${Date.now()}_${Math.random()}`)
  const journey = await client.startJourney({
    userId: user.userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  return { client, journeyId: journey.journeyId }
}

describe('小程序客户端打真实服务端', () => {
  test('普通 JSON 接口可用', async () => {
    const { journeyId } = await startJourney()

    expect(journeyId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('流式提问：真实 HTTP 分片能还原出完整事件序列', async () => {
    const { client, journeyId } = await startJourney()
    const events: WireEvent[] = []

    await new Promise<void>((resolve, reject) => {
      client.askStream(
        { journeyId, text: '古代人怎么考试', poiId: 'fzm_jiangnan_gongyuan' },
        { onEvent: (e) => events.push(e), onComplete: resolve, onError: reject },
      )
    })

    const types = events.map((e) => e.type)
    expect(types[0]).toBe('filler')
    expect(types).toContain('sentence')
    expect(types[types.length - 1]).toBe('done')
  })

  test('垫音事件带得到的 audioKey，能取回真实音频字节', async () => {
    const { client, journeyId } = await startJourney()
    let audioKey = ''

    await new Promise<void>((resolve, reject) => {
      client.askStream({ journeyId, text: '号舍多大' }, {
        onEvent: (e) => { if (e.type === 'filler') audioKey = e.audioKey },
        onComplete: resolve,
        onError: reject,
      })
    })

    expect(audioKey).not.toBe('')
    const res = await fetch(client.audioUrl(audioKey))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('中文不会在分片边界处乱码', async () => {
    const { client, journeyId } = await startJourney()
    let full = ''

    await new Promise<void>((resolve, reject) => {
      client.askStream({ journeyId, text: '讲讲科举' }, {
        onEvent: (e) => { if (e.type === 'done') full = e.text },
        onComplete: resolve,
        onError: reject,
      })
    })

    expect(full).not.toBe('')
    // 解码失败会留下替换字符
    expect(full).not.toContain('�')
  })

  test('done 事件带的时序字段齐全，供前端显示', async () => {
    const { client, journeyId } = await startJourney()
    let timing: WireEvent | undefined

    await new Promise<void>((resolve, reject) => {
      client.askStream({ journeyId, text: '这里讲讲' }, {
        onEvent: (e) => { if (e.type === 'done') timing = e },
        onComplete: resolve,
        onError: reject,
      })
    })

    expect(timing?.type).toBe('done')
    if (timing?.type === 'done') {
      expect(timing.timing.fillerAtMs).toBeGreaterThanOrEqual(0)
      expect(timing.timing.sentences).toBeGreaterThan(0)
    }
  })

  test('到达点位走服务端真实围栏判定', async () => {
    const { client, journeyId } = await startJourney()
    const now = Date.now()

    await client.sendSignals(journeyId, [
      { lat: 32.0211, lng: 118.7905, accuracyM: 12, at: new Date(now).toISOString(), speedMps: 0.4 },
      { lat: 32.0211, lng: 118.7905, accuracyM: 14, at: new Date(now + 25_000).toISOString(), speedMps: 0.3 },
    ])
    const result = await client.arrive(journeyId, 'fzm_jiangnan_gongyuan')

    expect(result.spoke).toBe(true)
    expect(result.text).toContain('号舍')
  })

  test('结束旅程与删除记录都能调通', async () => {
    const { client, journeyId } = await startJourney()

    await client.endJourney(journeyId)
    await client.deleteJourney(journeyId)
  })
})
