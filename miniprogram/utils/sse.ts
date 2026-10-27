import type { WireEvent } from '../shared/stream-events'

/**
 * SSE 帧解析。
 *
 * 服务端发的是标准 SSE：`event: <type>\n data: <json>\n\n`。
 * 分片边界同样会把一帧劈开，所以要缓冲到遇见空行才算一帧完整。
 *
 * 容错原则：**单帧坏掉不能让整段回答断掉**。解析失败的帧跳过并计数，
 * 而不是抛异常——用户宁可少听一句，也不要整个卡住。
 */

export type SseFrame = {
  readonly event: string | null
  readonly data: string
}

export type SseParser = {
  /** 喂一段文本，返回这次凑齐的完整帧 */
  push(text: string): readonly SseFrame[]
  /** 流结束时取出残留（通常为空；非空说明服务端没发完） */
  flush(): readonly SseFrame[]
  /** 解析失败的帧数，用于诊断 */
  readonly malformed: number
}

const FRAME_SEPARATOR = /\r?\n\r?\n/

const parseFrame = (block: string): SseFrame | null => {
  const lines = block.split(/\r?\n/)
  let event: string | null = null
  const dataLines: string[] = []

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue // 空行与注释
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon)
    // SSE 规定冒号后的单个空格要去掉
    const value = line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

export const createSseParser = (): SseParser => {
  let buffer = ''
  let malformed = 0

  const take = (final: boolean): readonly SseFrame[] => {
    const blocks = buffer.split(FRAME_SEPARATOR)
    // 最后一段可能是半帧，留到下次；flush 时才处理它
    buffer = final ? '' : (blocks.pop() ?? '')

    const frames: SseFrame[] = []
    for (const block of blocks) {
      if (block.trim() === '') continue
      const frame = parseFrame(block)
      if (frame === null) malformed += 1
      else frames.push(frame)
    }
    return frames
  }

  return {
    push(text: string): readonly SseFrame[] {
      if (text === '') return []
      buffer += text
      return take(false)
    },
    flush(): readonly SseFrame[] {
      if (buffer.trim() === '') {
        buffer = ''
        return []
      }
      return take(true)
    },
    get malformed(): number {
      return malformed
    },
  }
}

const KNOWN_TYPES = new Set([
  'filler', 'sentence', 'audio', 'delta', 'done', 'error',
])

/**
 * 把一帧转成类型化事件。
 * 未知类型返回 null —— 服务端加了新事件类型时，旧版本小程序应当忽略它而不是崩。
 */
export const toWireEvent = (frame: SseFrame): WireEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const type = (parsed as { type?: unknown }).type
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) return null

  return parsed as WireEvent
}
