import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ModelError, classifyHttpStatus } from '../models/errors.js'
import { signRequest } from '../tencent/sign.js'
import type { SynthesisRequest, SynthesisResult, TtsAdapter } from './types.js'

/**
 * 腾讯云语音合成（TextToVoice）。
 *
 * 选它的理由是产品形态：首发是微信小程序，用腾讯生态能让延迟、计费、
 * 备案和后续的 ASR / COS 走同一套账号体系。
 *
 * 文档核实要点（cloud.tencent.com/document/api/1073/37995，2026-10-25）：
 *   - Host tts.tencentcloudapi.com，Action TextToVoice，Version 2019-08-23
 *   - 鉴权是 TC3-HMAC-SHA256 签名，不是简单的 token（见 src/tencent/sign.ts）
 *   - **文本上限 150 汉字**，比火山的 300 紧一倍，分句器要按这个兜底
 *   - Speed 是档位 [-2, 6] 而不是倍率：-2≈0.6x、0=1.0x、6≈2.5x
 *   - 音频在 Response.Audio，base64
 *   - **业务错误也是 HTTP 200**，塞在 Response.Error 里，只判 response.ok 会把
 *     「音色无权限」当成功
 */

const HOST = 'tts.tencentcloudapi.com'
const SERVICE = 'tts'
const ACTION = 'TextToVoice'
const VERSION = '2019-08-23'
const TIMEOUT_MS = 10_000
const MAX_CHARS = 150

const responseSchema = z.object({
  Response: z.object({
    Audio: z.string().optional(),
    SessionId: z.string().optional(),
    RequestId: z.string().optional(),
    Error: z.object({ Code: z.string(), Message: z.string() }).optional(),
  }),
})

/** 这些错误码重试有意义，其余要改参数或配额 */
const RETRYABLE_CODES = new Set([
  'InternalError',
  'RequestLimitExceeded',
  'FailedOperation.ServiceIsolate',
])

/**
 * 契约里的 speedRatio 是倍率（1.0 = 正常），腾讯要的是档位 [-2, 6]。
 * 按文档给的三个锚点（-2→0.6x、0→1.0x、6→2.5x）线性插值——
 * 官方没公布完整曲线，这是近似，调音色时以实听为准。
 */
export const toTencentSpeed = (ratio: number): number => {
  const raw = ratio <= 1 ? (ratio - 1) / 0.2 : (ratio - 1) / 0.25
  return Number(Math.min(6, Math.max(-2, raw)).toFixed(2))
}

const CODEC_BY_ENCODING: Record<string, string> = {
  mp3: 'mp3', wav: 'wav', pcm: 'pcm', ogg_opus: 'mp3',
}

export type TencentTtsOptions = {
  readonly secretId: string
  readonly secretKey: string
  readonly region?: string
  /** 音色 ID 是整数；控制台「音色列表」里查 */
  readonly defaultVoiceType?: number
  readonly sampleRate?: number
}

export const createTencentTts = (options: TencentTtsOptions): TtsAdapter => {
  if (options.secretId === '' || options.secretKey === '') {
    throw new Error(
      '腾讯云 TTS 需要 TENCENT_SECRET_ID 与 TENCENT_SECRET_KEY（访问管理 → API 密钥）',
    )
  }

  return {
    name: 'tencent',
    maxChars: MAX_CHARS,

    async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
      if (request.text.length > MAX_CHARS) {
        throw new ModelError({
          kind: 'bad_request', provider: 'tencent',
          message: `待合成文本 ${request.text.length} 字超过腾讯云 ${MAX_CHARS} 汉字上限，` +
            `应先分句再逐句合成`,
        })
      }

      const voiceType = Number(request.voice)
      if (!Number.isInteger(voiceType)) {
        throw new ModelError({
          kind: 'bad_request', provider: 'tencent',
          message: `腾讯云音色是整数 ID（如 601000），收到「${request.voice}」。` +
            `在控制台「音色列表」查，用 TTS_VOICE_* 配置`,
        })
      }

      const encoding = request.encoding ?? 'mp3'
      const payload = JSON.stringify({
        Text: request.text,
        SessionId: randomUUID(),
        VoiceType: voiceType,
        Codec: CODEC_BY_ENCODING[encoding] ?? 'mp3',
        SampleRate: options.sampleRate ?? 16000,
        Speed: toTencentSpeed(request.speedRatio ?? 1),
      })

      const signed = signRequest({
        secretId: options.secretId,
        secretKey: options.secretKey,
        host: HOST,
        service: SERVICE,
        action: ACTION,
        version: VERSION,
        region: options.region,
        payload,
      })

      const started = Date.now()
      let response: Response
      try {
        response = await fetch(signed.url, {
          method: 'POST',
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        const isTimeout = error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new ModelError({
          kind: isTimeout ? 'timeout' : 'network', provider: 'tencent',
          message: isTimeout ? `TTS 超时（${TIMEOUT_MS}ms）` : `网络错误：${(error as Error).message}`,
          cause: error,
        })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ModelError({
          kind: classifyHttpStatus(response.status), provider: 'tencent',
          status: response.status, message: `HTTP ${response.status}：${text.slice(0, 200)}`,
        })
      }

      const parsed = responseSchema.safeParse(await response.json())
      if (!parsed.success) {
        throw new ModelError({
          kind: 'parse', provider: 'tencent',
          message: `响应结构不符合文档：${parsed.error.message.slice(0, 160)}`,
        })
      }

      // 业务错误也是 HTTP 200，必须单独看 Response.Error
      const apiError = parsed.data.Response.Error
      if (apiError !== undefined) {
        const isAuth = apiError.Code.startsWith('AuthFailure')
        throw new ModelError({
          kind: isAuth ? 'auth' : RETRYABLE_CODES.has(apiError.Code) ? 'server' : 'bad_request',
          provider: 'tencent',
          message: `${apiError.Code}：${apiError.Message}`,
        })
      }

      const audio = parsed.data.Response.Audio
      if (audio === undefined || audio === '') {
        throw new ModelError({
          kind: 'parse', provider: 'tencent', message: '合成成功但没有返回音频数据',
        })
      }

      return {
        audio: Buffer.from(audio, 'base64'),
        encoding,
        // 腾讯不返回时长，按中文播报速度估算
        durationMs: Math.round((request.text.length / 5) * 1000),
        provider: 'tencent',
        latencyMs: Date.now() - started,
        cached: false,
      }
    },
  }
}
