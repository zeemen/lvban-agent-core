/**
 * 增量 UTF-8 解码。
 *
 * 为什么要自己写：
 *   1. wx.request 的 onChunkReceived 给的是 ArrayBuffer，而且 **chunk 边界
 *      会把多字节字符劈开**——中文一个字 3 字节，分片切在字中间是常态，
 *      不是边缘情况。按分片独立解码会产出乱码。
 *   2. 小程序运行时不是浏览器，不能依赖全局 TextDecoder。
 *
 * 做法：每次只解码「完整字符」的部分，残缺的尾巴留到下一片拼上。
 */

/** 返回这段字节里构成完整 UTF-8 字符的长度 */
export const completeByteLength = (bytes: Uint8Array): number => {
  const len = bytes.length
  if (len === 0) return 0

  // UTF-8 一个字符最多 4 字节，所以最多往回看 4 个
  for (let back = 1; back <= 4 && back <= len; back += 1) {
    const b = bytes[len - back] as number

    // ASCII：它自己完整，且后面不会有续字节
    if ((b & 0x80) === 0) return len

    // 首字节：看它需要几个字节
    if ((b & 0xc0) === 0xc0) {
      const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4
      return back >= need ? len : len - back
    }
    // 续字节（10xxxxxx），继续往回找首字节
  }

  // 连续 4 个续字节：本身就是坏数据，交给解码器出替换字符，不要无限挂起
  return len
}

/** 纯 JS 的 UTF-8 解码，不依赖 TextDecoder / Buffer */
export const decodeUtf8 = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0

  while (i < bytes.length) {
    const b0 = bytes[i] as number
    let code: number
    let size: number

    if ((b0 & 0x80) === 0) {
      code = b0
      size = 1
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f
      size = 2
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f
      size = 3
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07
      size = 4
    } else {
      out += '�'
      i += 1
      continue
    }

    if (i + size > bytes.length) {
      out += '�'
      break
    }

    let valid = true
    for (let k = 1; k < size; k += 1) {
      const bk = bytes[i + k] as number
      if ((bk & 0xc0) !== 0x80) {
        valid = false
        break
      }
      code = (code << 6) | (bk & 0x3f)
    }

    if (!valid) {
      out += '�'
      i += 1
      continue
    }

    if (code > 0xffff) {
      // 超出 BMP：拆成代理对
      const v = code - 0x10000
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
    i += size
  }

  return out
}

export type Utf8StreamDecoder = {
  /** 喂一片字节，返回这次能确定的文本（残缺尾巴会留到下次） */
  push(chunk: ArrayBuffer | Uint8Array): string
  /** 流结束时取出残留。有残缺字节时产出替换字符而不是静默丢弃 */
  flush(): string
  /** 当前挂起的字节数，用于诊断 */
  readonly pending: number
}

export const createUtf8StreamDecoder = (): Utf8StreamDecoder => {
  let tail = new Uint8Array(0)

  return {
    push(chunk: ArrayBuffer | Uint8Array): string {
      const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      if (incoming.length === 0) return ''

      const merged = new Uint8Array(tail.length + incoming.length)
      merged.set(tail, 0)
      merged.set(incoming, tail.length)

      const cut = completeByteLength(merged)
      tail = merged.slice(cut)
      return cut === 0 ? '' : decodeUtf8(merged.subarray(0, cut))
    },

    flush(): string {
      if (tail.length === 0) return ''
      const rest = decodeUtf8(tail)
      tail = new Uint8Array(0)
      return rest
    },

    get pending(): number {
      return tail.length
    },
  }
}
