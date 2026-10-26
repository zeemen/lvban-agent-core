/**
 * TTS 契约 —— 规格 03 §7 的语音链路。
 *
 * 与 ModelAdapter 分开的理由：TTS 不是 OpenAI 兼容接口。
 * 火山引擎用 appid + access_token，鉴权头是 `Bearer;${token}`（分号，不是空格），
 * 请求体里那个 token 字段官方注明是「无实际鉴权作用的 Fake token」。
 * 把它硬塞进 ModelAdapter 只会让两边都变形。
 */

export type AudioEncoding = 'mp3' | 'wav' | 'pcm' | 'ogg_opus'

export type SynthesisRequest = {
  readonly text: string
  /** 音色代号，由供应商定义 */
  readonly voice: string
  readonly encoding?: AudioEncoding
  /** 语速 [0.1, 2]，默认 1 */
  readonly speedRatio?: number
  /** 采样率，默认 24000 */
  readonly rate?: number
}

export type SynthesisResult = {
  readonly audio: Buffer
  readonly encoding: AudioEncoding
  readonly durationMs: number | null
  readonly provider: string
  readonly latencyMs: number
  readonly cached: boolean
}

export type TtsAdapter = {
  readonly name: string
  /**
   * 单次请求的文本上限（字）。各家不同：
   * 火山 300 字建议值，腾讯 150 汉字硬上限。
   * 分句器要按这个值兜底切分，否则长句会被供应商直接拒绝。
   */
  readonly maxChars: number
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>
}

/**
 * 规格 03 §7 给 TTS 首句的预算。
 * 这是**首句**的预算：后续句子在用户听前一句时合成，不在关键路径上。
 */
export const TTS_FIRST_SENTENCE_BUDGET_MS = 600

/** 保守默认值；各适配器用自己的 maxChars 覆盖 */
export const DEFAULT_MAX_SYNTHESIS_CHARS = 150
