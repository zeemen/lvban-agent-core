import { describe, expect, test, vi } from 'vitest'
import { createClient, type RequestFn, type RequestOptions } from '../../miniprogram/utils/api'
import { createAudioQueue, type AudioContextLike } from '../../miniprogram/utils/audio'
import type { WireEvent } from '../../miniprogram/shared/stream-events'

/**
 * 小程序客户端 —— 整条 ArrayBuffer → UTF-8 → SSE → 事件 的流水线。
 * request 可注入，所以不开模拟器也能把最难的那段测掉。
 */

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const toBytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

/** 模拟 wx.request：把给定文本按指定字节数切片，逐片交给 onChunkReceived */
const chunkedRequest = (payload: string, chunkBytes: number): {
  request: RequestFn; calls: RequestOptions[]
} => {
  const calls: RequestOptions[] = []
  const request: RequestFn = (options) => {
    calls.push(options)
    const bytes = toBytes(payload)
    let listener: ((res: { data: ArrayBuffer }) => void) | null = null
    queueMicrotask(() => {
      for (let i = 0; i < bytes.length; i += chunkBytes) {
        const slice = bytes.subarray(i, i + chunkBytes)
        listener?.({
          data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        })
      }
      options.success?.({ statusCode: 200, data: '' })
    })
    return {
      abort: () => undefined,
      onChunkReceived(cb) { listener = cb },
    }
  }
  return { request, calls }
}

const collect = (payload: string, chunkBytes: number): Promise<WireEvent[]> =>
  new Promise((resolve) => {
    const events: WireEvent[] = []
    const { request } = chunkedRequest(payload, chunkBytes)
    createClient({ baseUrl: 'https://x.test', request }).askStream(
      { journeyId: 'j1', text: '古代人怎么考试' },
      { onEvent: (e) => events.push(e), onComplete: () => resolve(events) },
    )
  })

const FULL_STREAM =
  sse('filler', { type: 'filler', text: '等我想想怎么说。', audioKey: 'fillers/a.mp3', fillerId: 'f1' }) +
  sse('sentence', { type: 'sentence', index: 0, text: '你现在站的这排小格子就是考场。', atMs: 1300 }) +
  sse('audio', { type: 'audio', index: 0, audioKey: 'x/0.mp3', durationMs: 4000, cached: false, synthMs: 300, atMs: 1600 }) +
  sse('sentence', { type: 'sentence', index: 1, text: '九天九夜吃住考都在里面。', atMs: 1900 }) +
  sse('done', {
    type: 'done', text: '你现在站的这排小格子就是考场。九天九夜吃住考都在里面。',
    guardViolations: [],
    timing: { fillerAtMs: 7, firstDeltaMs: 1000, firstSentenceMs: 1300, firstAudioMs: 1600, totalMs: 2100, sentences: 2, ttsProvider: 'tencent' },
  })

describe('askStream 流水线', () => {
  test('完整流能还原出全部事件', async () => {
    const events = await collect(FULL_STREAM, 4096)

    expect(events.map((e) => e.type)).toEqual(['filler', 'sentence', 'audio', 'sentence', 'done'])
  })

  test.each([1, 2, 3, 5, 17, 64])('分片 %i 字节都能还原（中文会被劈开）', async (size) => {
    const events = await collect(FULL_STREAM, size)

    expect(events.map((e) => e.type)).toEqual(['filler', 'sentence', 'audio', 'sentence', 'done'])
    const first = events[1]
    if (first?.type === 'sentence') {
      expect(first.text).toBe('你现在站的这排小格子就是考场。')
    }
  })

  test('垫音永远是第一个事件 —— 它决定用户多久听到声音', async () => {
    const events = await collect(FULL_STREAM, 3)

    expect(events[0]?.type).toBe('filler')
    if (events[0]?.type === 'filler') expect(events[0].audioKey).toBe('fillers/a.mp3')
  })

  test('开启了 enableChunked，否则拿不到分片', async () => {
    const { request, calls } = chunkedRequest(FULL_STREAM, 64)
    await new Promise<void>((resolve) => {
      createClient({ baseUrl: 'https://x.test', request }).askStream(
        { journeyId: 'j1', text: 'q' }, { onEvent: () => undefined, onComplete: resolve },
      )
    })

    expect(calls[0]?.enableChunked).toBe(true)
    expect(calls[0]?.url).toBe('https://x.test/v1/journeys/j1/ask/stream')
  })

  test('基础库过低（没有 onChunkReceived）时明确报错，而不是静默无声', async () => {
    const request: RequestFn = () => ({ abort: () => undefined })
    const messages: string[] = []

    createClient({ baseUrl: 'https://x.test', request }).askStream(
      { journeyId: 'j1', text: 'q' },
      { onEvent: () => undefined, onError: (m) => messages.push(m) },
    )

    expect(messages[0]).toMatch(/2\.20\.2/)
  })

  test('未知事件类型被忽略，不影响其余事件', async () => {
    const payload = sse('future', { type: 'brand_new_event', foo: 1 }) +
      sse('done', { type: 'done', text: 'x', guardViolations: [], timing: {} })

    const events = await collect(payload, 7)

    expect(events.map((e) => e.type)).toEqual(['done'])
  })

  test('网络失败走 onError', async () => {
    const request: RequestFn = (options) => {
      queueMicrotask(() => options.fail?.({ errMsg: 'request:fail timeout' }))
      return { abort: () => undefined, onChunkReceived: () => undefined }
    }
    const messages: string[] = []

    await new Promise<void>((resolve) => {
      createClient({ baseUrl: 'https://x.test', request }).askStream(
        { journeyId: 'j1', text: 'q' },
        { onEvent: () => undefined, onError: (m) => { messages.push(m); resolve() } },
      )
    })

    expect(messages[0]).toContain('timeout')
  })
})

describe('无 body 的请求', () => {
  test('不带 content-type —— 声明了 JSON 却是空 body 会被服务端 400', async () => {
    const calls: RequestOptions[] = []
    const request: RequestFn = (options) => {
      calls.push(options)
      queueMicrotask(() => options.success?.({ statusCode: 200, data: {} }))
      return { abort: () => undefined }
    }

    await createClient({ baseUrl: 'https://x.test', request }).endJourney('j1')

    expect(calls[0]?.header?.['content-type']).toBeUndefined()
  })

  test('有 body 时仍然带 content-type', async () => {
    const calls: RequestOptions[] = []
    const request: RequestFn = (options) => {
      calls.push(options)
      queueMicrotask(() => options.success?.({ statusCode: 201, data: {} }))
      return { abort: () => undefined }
    }

    await createClient({ baseUrl: 'https://x.test', request }).createDevUser('o1')

    expect(calls[0]?.header?.['content-type']).toBe('application/json')
  })
})

describe('audioUrl', () => {
  test('按 audioKey 拼出取音频的地址', () => {
    const client = createClient({ baseUrl: 'https://x.test/', request: (() => ({ abort: () => undefined })) as RequestFn })

    expect(client.audioUrl('fillers/peer_q_01.mp3'))
      .toBe('https://x.test/v1/audio/fillers/peer_q_01.mp3')
  })
})

describe('createAudioQueue', () => {
  const fakeContext = () => {
    const handlers: { ended?: () => void; error?: (e: unknown) => void } = {}
    const ctx: AudioContextLike & { played: boolean } = {
      src: '', played: false,
      play() { this.played = true },
      stop() { /* noop */ },
      destroy() { /* noop */ },
      onEnded(cb) { handlers.ended = cb },
      onError(cb) { handlers.error = cb },
    }
    return { ctx, handlers }
  }

  test('第一段立刻开播', () => {
    const made = fakeContext()
    const q = createAudioQueue({ createContext: () => made.ctx })

    q.push('a.mp3')

    expect(made.ctx.src).toBe('a.mp3')
    expect(made.ctx.played).toBe(true)
    expect(q.playing).toBe(true)
  })

  test('播放期间入队的排后面，不打断当前', () => {
    const made = fakeContext()
    const q = createAudioQueue({ createContext: () => made.ctx })
    q.push('a.mp3')

    q.push('b.mp3')

    expect(made.ctx.src).toBe('a.mp3')
    expect(q.pending).toBe(1)
  })

  test('前一段结束后自动播下一段', () => {
    const contexts = [fakeContext(), fakeContext()]
    let i = 0
    const q = createAudioQueue({ createContext: () => (contexts[i++] as typeof contexts[0]).ctx })
    q.push('a.mp3')
    q.push('b.mp3')

    contexts[0]?.handlers.ended?.()

    expect(contexts[1]?.ctx.src).toBe('b.mp3')
    void q
  })

  test('一段出错时跳过它继续播，而不是整条哑掉', () => {
    const contexts = [fakeContext(), fakeContext()]
    let i = 0
    const errors: string[] = []
    const q = createAudioQueue({
      createContext: () => (contexts[i++] as typeof contexts[0]).ctx,
      onError: (src) => errors.push(src),
    })
    q.push('bad.mp3')
    q.push('good.mp3')

    contexts[0]?.handlers.error?.(new Error('404'))

    expect(errors).toEqual(['bad.mp3'])
    expect(contexts[1]?.ctx.src).toBe('good.mp3')
  })

  test('clear 丢弃未播并停止当前 —— 用户打断时用', () => {
    const made = fakeContext()
    const stop = vi.fn()
    const q = createAudioQueue({ createContext: () => ({ ...made.ctx, stop }) })
    q.push('a.mp3')
    q.push('b.mp3')

    q.clear()

    expect(stop).toHaveBeenCalled()
    expect(q.pending).toBe(0)
    expect(q.playing).toBe(false)
  })

  test('队列放空时回调 onDrained', () => {
    const made = fakeContext()
    const onDrained = vi.fn()
    const q = createAudioQueue({ createContext: () => made.ctx, onDrained })
    q.push('a.mp3')

    made.handlers.ended?.()

    expect(onDrained).toHaveBeenCalled()
    void q
  })
})
