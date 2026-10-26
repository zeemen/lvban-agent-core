/**
 * 增量分句 —— 规格 03 §7 的流式分句合成。
 *
 * TTS 不能等整段说完再合成，否则流式就白做了：
 * 第一句话一旦完整就送去合成，后面的句子边生成边排队。
 *
 * 太短的句子单独合成反而更慢（每次合成都有固定开销，而且听感是断的），
 * 所以不足 MIN_CHARS 的句子与后一句合并后再发。
 */

const TERMINATORS = /[。！？!?；;…]/
const MIN_CHARS = 6

export type SentenceSplitter = {
  /** 喂入一段增量，返回这次新凑齐的完整句子 */
  push(delta: string): readonly string[]
  /** 流结束时取出残留的尾巴 */
  flush(): readonly string[]
  /** 已经吐出过多少句 */
  readonly count: number
}

export const createSentenceSplitter = (): SentenceSplitter => {
  let buffer = ''
  let emitted = 0

  const take = (): readonly string[] => {
    const out: string[] = []
    // 不足 MIN_FIRST_CHARS 的句子不单独成段，继续往后拼，而不是退回缓冲区——
    // 退回会让它下次被原样再取出来，永远合并不上
    let pending = ''

    for (;;) {
      const match = TERMINATORS.exec(buffer)
      if (match === null) break
      const end = match.index + match[0].length
      const piece = buffer.slice(0, end).trim()
      buffer = buffer.slice(end)
      if (piece === '') continue

      pending += piece
      if (pending.length >= MIN_CHARS) {
        out.push(pending)
        pending = ''
      }
    }

    // 还没凑够字数的，留回缓冲区等后续增量
    if (pending !== '') buffer = pending + buffer
    emitted += out.length
    return out
  }

  return {
    push(delta: string): readonly string[] {
      buffer += delta
      return take()
    },
    flush(): readonly string[] {
      const tail = buffer.trim()
      buffer = ''
      if (tail === '') return []
      emitted += 1
      return [tail]
    },
    get count(): number {
      return emitted
    },
  }
}
