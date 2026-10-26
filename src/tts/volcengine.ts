import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ModelError, classifyHttpStatus } from '../models/errors.js'
import type { SynthesisRequest, SynthesisResult, TtsAdapter } from './types.js'

/**
 * 火山引擎（豆包语音）V1 HTTP 非流式 TTS。
 *
 * 文档核实要点（docs.volcengine.com/docs/6561/1257584，2026-10-25）：
 *   - 鉴权头是 `Bearer;${token}`，**分号**不是空格；写错会报
 *     "authenticate request: load grant: requested grant not found"
 *   - 请求体 app.token 官方注明是「无实际鉴权作用的 Fake token」，
 *     任意非空字符串即可——真正的鉴权在 header 上
 *   - reqid 每次必须唯一
 *   - 文本上限 1024 字节（UTF-8），建议 <300 字符
 *   - 音频在 data 字段里，base64 编码
 *   - code=3000 才是成功，HTTP 200 不代表合成成功
 *
 * 为什么先用「不推荐」的 V1：垫音是预合成的固定音频、根本不需要流式；
 * 正文每句只有 20–60 字，一次性合成足够。V3 SSE
 * （/api/v3/tts/unidirectional/sse，流式吐音频、时延更好）留给后续优化，
 * 换过去只需要再写一个实现 TtsAdapter 的文件。
 */

const ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts'
const SUCCESS_CODE = 3000
const DEFAULT_CLUSTER = 'volcano_tts'
const TIMEOUT_MS = 10_000
/** 文档：1024 字节（UTF-8），建议 <300 字符 */
const MAX_CHARS = 300

const responseSchema = z.object({
  reqid: z.string().optional(),
  code: z.number(),
  message: z.string().optional(),
  data: z.string().optional(),
  addition: z.object({ duration: z.string().optional() }).optional(),
})

/** 文档列出的错误码；这里只区分「重试有用」和「改参数」 */
const RETRYABLE_CODES = new Set([3003, 3005, 3030, 3031, 3032, 3040])

export type VolcengineOptions = {
  readonly appId: string
  readonly accessToken: string
  readonly cluster?: string
  readonly uid?: string
}

export const createVolcengineTts = (options: VolcengineOptions): TtsAdapter => {
  if (options.appId === '' || options.accessToken === '') {
    throw new Error(
      '火山引擎 TTS 需要 VOLC_TTS_APP_ID 与 VOLC_TTS_ACCESS_TOKEN（控制台「语音技术」里拿）',
    )
  }

  return {
    name: 'volcengine',
    maxChars: MAX_CHARS,

    async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
      if (request.text.length > MAX_CHARS) {
        throw new ModelError({
          kind: 'bad_request', provider: 'volcengine',
          message: `待合成文本 ${request.text.length} 字超过 ${MAX_CHARS} 字上限，` +
            `应先分句再逐句合成`,
        })
      }

      const encoding = request.encoding ?? 'mp3'
      const started = Date.now()

      let response: Response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // 分号分隔，不是空格 —— 写成 `Bearer ${token}` 会鉴权失败
            authorization: `Bearer;${options.accessToken}`,
          },
          body: JSON.stringify({
            app: {
              appid: options.appId,
              // 官方注明此字段无实际鉴权作用，但必须非空
              token: 'placeholder',
              cluster: options.cluster ?? DEFAULT_CLUSTER,
            },
            user: { uid: options.uid ?? 'lvban' },
            audio: {
              voice_type: request.voice,
              encoding,
              speed_ratio: request.speedRatio ?? 1.0,
              ...(request.rate === undefined ? {} : { rate: request.rate }),
            },
            request: {
              reqid: randomUUID(),
              text: request.text,
              operation: 'query',
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        const isTimeout = error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new ModelError({
          kind: isTimeout ? 'timeout' : 'network',
          provider: 'volcengine',
          message: isTimeout ? `TTS 超时（${TIMEOUT_MS}ms）` : `网络错误：${(error as Error).message}`,
          cause: error,
        })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ModelError({
          kind: classifyHttpStatus(response.status), provider: 'volcengine',
          status: response.status, message: `HTTP ${response.status}：${text.slice(0, 200)}`,
        })
      }

      const parsed = responseSchema.safeParse(await response.json())
      if (!parsed.success) {
        throw new ModelError({
          kind: 'parse', provider: 'volcengine',
          message: `响应结构不符合文档：${parsed.error.message.slice(0, 160)}`,
        })
      }

      // HTTP 200 不代表合成成功，要看 code
      if (parsed.data.code !== SUCCESS_CODE) {
        throw new ModelError({
          kind: RETRYABLE_CODES.has(parsed.data.code) ? 'server' : 'bad_request',
          provider: 'volcengine',
          message: `TTS code=${parsed.data.code}：${parsed.data.message ?? '无错误信息'}`,
        })
      }

      const base64 = parsed.data.data
      if (base64 === undefined || base64 === '') {
        throw new ModelError({
          kind: 'parse', provider: 'volcengine', message: '合成成功但没有返回音频数据',
        })
      }

      const duration = parsed.data.addition?.duration
      return {
        audio: Buffer.from(base64, 'base64'),
        encoding,
        durationMs: duration === undefined ? null : Number(duration),
        provider: 'volcengine',
        latencyMs: Date.now() - started,
        cached: false,
      }
    },
  }
}
