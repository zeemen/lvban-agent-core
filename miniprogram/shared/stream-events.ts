/**
 * SSE 线上契约 —— 服务端与小程序共用这一份。
 *
 * 为什么要共用：这个仓库里已经出现过两次「两处各写一份、随后漂移」的问题
 * （lint 与运行时渲染路径、流式与非流式的 prompt）。跨网络的契约更没有
 * 自我纠正的机会——前端解析错了只会表现为「有时候没声音」。
 *
 * 这里只描述**真正跨网络的字段**。服务端内部的 PlanDecision、ContextState
 * 比这丰富，结构化类型保证它们仍可赋值给这里的窄类型。
 *
 * 为什么放在 miniprogram/ 下而不是仓库根的 shared/：
 * 微信开发者工具只打包 miniprogramRoot 以内的文件，小程序这边有硬约束；
 * 服务端没有，所以由服务端反向引用这里。
 */

export type WireFiller = {
  readonly type: 'filler'
  readonly text: string
  readonly audioKey: string
  readonly fillerId: string
}

export type WireSentence = {
  readonly type: 'sentence'
  readonly index: number
  readonly text: string
  readonly atMs: number
}

export type WireAudio = {
  readonly type: 'audio'
  readonly index: number
  readonly audioKey: string
  readonly durationMs: number | null
  readonly cached: boolean
  readonly synthMs: number
  readonly atMs: number
}

export type WireDelta = {
  readonly type: 'delta'
  readonly text: string
}

export type WireTiming = {
  readonly fillerAtMs: number
  readonly firstDeltaMs: number | null
  readonly firstSentenceMs: number | null
  readonly firstAudioMs: number | null
  readonly totalMs: number
  readonly sentences: number
  readonly ttsProvider: string | null
}

export type WireDone = {
  readonly type: 'done'
  readonly text: string
  readonly guardViolations: readonly string[]
  readonly timing: WireTiming
}

export type WireError = {
  readonly type: 'error'
  readonly message: string
  readonly fallbackText: string
}

export type WireEvent =
  | WireFiller | WireSentence | WireAudio | WireDelta | WireDone | WireError

export const WIRE_EVENT_TYPES = [
  'filler', 'sentence', 'audio', 'delta', 'done', 'error',
] as const
