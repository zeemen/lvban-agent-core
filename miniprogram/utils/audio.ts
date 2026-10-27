/**
 * 顺序音频队列。
 *
 * 语音是一句一句到的：垫音先播，正文第一句合成好时垫音可能还没放完，
 * 第二句又在第一句播放期间到达。所以不能来一句播一句，要排队。
 *
 * 规格 03 要求语音流锁屏可听——真正的后台播放要用
 * wx.getBackgroundAudioManager，但它一次只能有一个实例、且会占用系统播放器 UI。
 * 行中逐句播放用 InnerAudioContext 更合适；锁屏连续播放在接入真实 TTS
 * 后另行设计（见 README）。
 *
 * 音频上下文做成可注入，便于在 Node 里测队列逻辑。
 */

export type AudioContextLike = {
  src: string
  play(): void
  stop(): void
  destroy(): void
  onEnded(cb: () => void): void
  onError(cb: (err: unknown) => void): void
}

export type AudioQueueOptions = {
  readonly createContext: () => AudioContextLike
  /** 一段音频出错时的回调；队列会跳过它继续播下一段 */
  readonly onError?: (src: string, err: unknown) => void
  readonly onTrackStart?: (src: string) => void
  readonly onDrained?: () => void
}

export type AudioQueue = {
  /** 入队并在空闲时立刻开播 */
  push(src: string): void
  /** 丢弃未播的，停止当前 —— 用户打断时用 */
  clear(): void
  destroy(): void
  readonly playing: boolean
  readonly pending: number
}

export const createAudioQueue = (options: AudioQueueOptions): AudioQueue => {
  const queue: string[] = []
  let current: AudioContextLike | null = null
  let destroyed = false

  const playNext = (): void => {
    if (destroyed) return
    const src = queue.shift()
    if (src === undefined) {
      current = null
      options.onDrained?.()
      return
    }

    const ctx = options.createContext()
    current = ctx
    // 先挂回调再设 src：有些实现设 src 即开始加载，晚挂会漏事件
    ctx.onEnded(() => {
      ctx.destroy()
      if (current === ctx) playNext()
    })
    ctx.onError((err) => {
      options.onError?.(src, err)
      ctx.destroy()
      // 一段放不出来不该让后面的全哑掉
      if (current === ctx) playNext()
    })
    ctx.src = src
    options.onTrackStart?.(src)
    ctx.play()
  }

  return {
    push(src: string): void {
      if (destroyed) return
      queue.push(src)
      if (current === null) playNext()
    },

    clear(): void {
      queue.length = 0
      if (current !== null) {
        const ctx = current
        current = null
        ctx.stop()
        ctx.destroy()
      }
    },

    destroy(): void {
      this.clear()
      destroyed = true
    },

    get playing(): boolean {
      return current !== null
    },

    get pending(): number {
      return queue.length
    },
  }
}

/** 小程序环境下的默认实现 */
export const wxAudioContextFactory = (): AudioContextLike => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.wx?.createInnerAudioContext === undefined) {
    throw new Error('不在小程序环境中：请注入 createContext')
  }
  return g.wx.createInnerAudioContext() as AudioContextLike
}
