import type { SynthesisRequest, SynthesisResult, TtsAdapter } from './types.js'

/**
 * Mock TTS。离线开发与测试用，也让「没配 TTS 时链路照样跑通」成立。
 *
 * 产出的是一段可识别的占位字节，不是真音频——
 * 调用方只关心「拿到了 Buffer、知道时长」，不关心内容。
 */

/** 中文播报速度约 5 字/秒 */
const CHARS_PER_SECOND = 5
const BYTES_PER_MS = 4

export const createMockTts = (): TtsAdapter => ({
  name: 'mock',
  maxChars: 150,
  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const durationMs = Math.round((request.text.length / CHARS_PER_SECOND) * 1000)
    const header = Buffer.from(`MOCKTTS:${request.voice}:${request.text}`, 'utf8')
    const padding = Buffer.alloc(Math.max(0, durationMs * BYTES_PER_MS))
    return {
      audio: Buffer.concat([header, padding]),
      encoding: request.encoding ?? 'mp3',
      durationMs,
      provider: 'mock',
      latencyMs: 1,
      cached: false,
    }
  },
})
