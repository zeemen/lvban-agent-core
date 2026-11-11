import { readFile } from 'node:fs/promises'
import { ModelError } from './errors.js'

/**
 * imageKey → 可直接塞进 OpenAI 兼容 `image_url` 的字符串（规格 02 §4.2）。
 *
 * 接受三种形式：http(s) 地址、data URI、本地文件路径（可带 file:// 前缀）。
 *
 * 300KB 这道闸对三种形式都生效。小程序走的是 data URI——§4.2 要的
 * 「直传对象存储、回传 key」还没有——而原先 data: 开头是直接放行的，
 * 于是「前端压到 300KB 以内」这条要求在实际走的那条路上没有任何把关。
 * 视觉这一跳的延迟直接压在「按下快门到出声」上，一张手机原图能到 4MB。
 */

export const MAX_IMAGE_BYTES = 300 * 1024

const kb = (bytes: number): number => Math.round(bytes / 1024)

const tooBig = (bytes: number): ModelError => new ModelError({
  kind: 'invalid_input', provider: 'openai-compatible',
  message: `图片 ${kb(bytes)}KB 超过 ${kb(MAX_IMAGE_BYTES)}KB 上限，应在前端压缩后上传`,
})

/** base64 串长反推解码字节数，不用为了量大小先解一遍 */
const decodedBytes = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length / 4) * 3 - padding
}

const checkDataUri = (imageKey: string): string => {
  const comma = imageKey.indexOf(',')
  // 没有逗号就不是合法 data URI，交给下游供应商报错，这里不多猜
  if (comma < 0) return imageKey
  const bytes = decodedBytes(imageKey.slice(comma + 1))
  if (bytes > MAX_IMAGE_BYTES) throw tooBig(bytes)
  return imageKey
}

export const toImageUrl = async (imageKey: string): Promise<string> => {
  if (imageKey.startsWith('http://') || imageKey.startsWith('https://')) return imageKey
  if (imageKey.startsWith('data:')) return checkDataUri(imageKey)

  const path = imageKey.startsWith('file://') ? imageKey.slice('file://'.length) : imageKey
  const bytes = await readFile(path).catch((error: unknown) => {
    throw new ModelError({
      kind: 'invalid_input', provider: 'openai-compatible',
      message: `读不到图片：${path}（imageKey 需为 http(s) URL、data URI 或本地文件路径）`,
      cause: error,
    })
  })
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw tooBig(bytes.byteLength)
  return `data:image/jpeg;base64,${bytes.toString('base64')}`
}
