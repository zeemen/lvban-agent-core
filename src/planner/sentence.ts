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
/** 退而求其次的切分点：没有句末标点时在这里断 */
const SOFT_BREAKS = /[，,、：:]/g
const MIN_CHARS = 6
/** 不设上限时的默认值；调用方应传入 TTS 适配器的 maxChars */
const DEFAULT_MAX_CHARS = 150

export type SentenceSplitter = {
  /** 喂入一段增量，返回这次新凑齐的完整句子 */
  push(delta: string): readonly string[]
  /** 流结束时取出残留的尾巴 */
  flush(): readonly string[]
  /** 已经吐出过多少句 */
  readonly count: number
}

export type SplitterOptions = {
  /**
   * 单句上限。各家 TTS 不同：腾讯 150 汉字是硬上限、火山 300 是建议值。
   * 超过这个长度而迟迟没有句末标点时，在逗号处强制断开——
   * 否则整句会被供应商拒绝，用户什么也听不到。
   */
  readonly maxChars?: number
}

export const createSentenceSplitter = (
  options: SplitterOptions = {},
): SentenceSplitter => {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  let buffer = ''
  let emitted = 0

  /** 在不超过上限的前提下，尽量找一个靠后的逗号断开 */
  const forceBreak = (): string => {
    const window = buffer.slice(0, maxChars)
    let cut = -1
    for (const match of window.matchAll(SOFT_BREAKS)) {
      if (match.index !== undefined && match.index + 1 >= MIN_CHARS) {
        cut = match.index + 1
      }
    }
    const end = cut > 0 ? cut : maxChars
    const piece = buffer.slice(0, end)
    buffer = buffer.slice(end)
    return piece
  }

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

    // 迟迟没有句末标点、已经超过上限：强制断开，否则这句会被 TTS 拒绝
    while (buffer.length > maxChars) {
      const piece = forceBreak().trim()
      if (piece === '') break
      out.push(piece)
    }

    emitted += out.length
    return out
  }

  return {
    push(delta: string): readonly string[] {
      buffer += delta
      return take()
    },
    flush(): readonly string[] {
      const out: string[] = []
      while (buffer.length > maxChars) {
        const piece = forceBreak().trim()
        if (piece === '') break
        out.push(piece)
      }
      const tail = buffer.trim()
      buffer = ''
      if (tail !== '') out.push(tail)
      emitted += out.length
      return out
    },
    get count(): number {
      return emitted
    },
  }
}
