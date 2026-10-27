import { describe, expect, test } from 'vitest'
import { createSseParser, toWireEvent } from '../../miniprogram/utils/sse'

/** SSE 帧解析 —— 分片边界会劈开一帧，单帧坏掉不能让整段回答断掉 */

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('createSseParser', () => {
  test('一帧完整到达时解析出来', () => {
    const p = createSseParser()

    const frames = p.push(frame('filler', { type: 'filler', text: '嗯' }))

    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe('filler')
  })

  test('半帧先到时不吐出，补齐后才吐', () => {
    const p = createSseParser()
    const whole = frame('sentence', { type: 'sentence', index: 0, text: '你好' })
    const cut = Math.floor(whole.length / 2)

    expect(p.push(whole.slice(0, cut))).toHaveLength(0)
    expect(p.push(whole.slice(cut))).toHaveLength(1)
  })

  test.each([1, 3, 7, 20])('每 %i 字符喂一次都能还原全部帧', (size) => {
    const payload = frame('filler', { type: 'filler', text: '嗯' }) +
      frame('sentence', { type: 'sentence', index: 0, text: '第一句' }) +
      frame('done', { type: 'done', text: '第一句' })
    const p = createSseParser()
    const out = []
    for (let i = 0; i < payload.length; i += size) {
      out.push(...p.push(payload.slice(i, i + size)))
    }
    out.push(...p.flush())

    expect(out.map((f) => f.event)).toEqual(['filler', 'sentence', 'done'])
  })

  test('一次喂入多帧全部解析', () => {
    const p = createSseParser()

    const frames = p.push(
      frame('a', { type: 'delta', text: '1' }) + frame('b', { type: 'delta', text: '2' }),
    )

    expect(frames).toHaveLength(2)
  })

  test('CRLF 换行同样支持', () => {
    const p = createSseParser()

    const frames = p.push('event: filler\r\ndata: {"type":"filler"}\r\n\r\n')

    expect(frames[0]?.event).toBe('filler')
  })

  test('冒号后的单个空格按规范去掉，多余空格保留', () => {
    const p = createSseParser()

    const frames = p.push('event: x\ndata:  {"a":1}\n\n')

    expect(frames[0]?.data).toBe(' {"a":1}')
  })

  test('注释行被忽略', () => {
    const p = createSseParser()

    const frames = p.push(': keep-alive\nevent: x\ndata: {"a":1}\n\n')

    expect(frames).toHaveLength(1)
  })

  test('没有 data 的帧算坏帧，计数但不抛错', () => {
    const p = createSseParser()

    const frames = p.push('event: x\n\n')

    expect(frames).toHaveLength(0)
    expect(p.malformed).toBe(1)
  })

  test('flush 取出没有空行收尾的残帧', () => {
    const p = createSseParser()
    p.push('event: done\ndata: {"type":"done"}')

    expect(p.flush()).toHaveLength(1)
  })

  test('flush 后缓冲清空，不重复吐出', () => {
    const p = createSseParser()
    p.push('event: done\ndata: {"type":"done"}')
    p.flush()

    expect(p.flush()).toHaveLength(0)
  })
})

describe('toWireEvent', () => {
  test('合法事件被转成类型化对象', () => {
    const event = toWireEvent({
      event: 'filler',
      data: '{"type":"filler","text":"嗯","audioKey":"a.mp3","fillerId":"f1"}',
    })

    expect(event).toMatchObject({ type: 'filler', audioKey: 'a.mp3' })
  })

  test('坏 JSON 返回 null，不抛错', () => {
    expect(toWireEvent({ event: 'x', data: '{不是 JSON' })).toBeNull()
  })

  test('未知事件类型返回 null —— 服务端加新类型时旧客户端应忽略而不是崩', () => {
    expect(toWireEvent({ event: 'x', data: '{"type":"future_event"}' })).toBeNull()
  })

  test('缺 type 字段返回 null', () => {
    expect(toWireEvent({ event: 'x', data: '{"text":"没有 type"}' })).toBeNull()
  })

  test('非对象返回 null', () => {
    expect(toWireEvent({ event: 'x', data: '"just a string"' })).toBeNull()
  })
})
