import { createHash, createHmac } from 'node:crypto'

/**
 * 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名。
 *
 * 放在 src/tencent/ 而不是 src/tts/：同一套签名后续 ASR、COS 都要用。
 *
 * 这段代码的每一个字节都影响结果——多一个空格、大小写错一处、
 * 时间戳用了本地时区，服务端都只回一句笼统的
 * `AuthFailure.SignatureFailure`。所以官方文档里那两个可离线验证的中间值
 * （规范请求哈希、载荷哈希）被锁进了测试向量。
 *
 * 文档：cloud.tencent.com/document/api/1073/30636（2026-10-25 核实）
 */

const ALGORITHM = 'TC3-HMAC-SHA256'
const CONTENT_TYPE = 'application/json; charset=utf-8'

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest()

/** 时间戳必须按 UTC 取日期，用本地时区会在跨时区时签失败 */
export const utcDate = (timestampSec: number): string =>
  new Date(timestampSec * 1000).toISOString().slice(0, 10)

export type CanonicalInput = {
  readonly host: string
  readonly action: string
  readonly payload: string
}

/** 规范请求：错得最多的地方，所以单独暴露出来做测试 */
export const canonicalRequest = (input: CanonicalInput): string => {
  const headers = [
    `content-type:${CONTENT_TYPE}`,
    `host:${input.host}`,
    // X-TC-Action 参与签名时必须小写
    `x-tc-action:${input.action.toLowerCase()}`,
  ].join('\n')

  return [
    'POST',
    '/',
    '', // POST 的查询串为空
    headers,
    '', // 规范头部块以空行收尾
    'content-type;host;x-tc-action',
    sha256Hex(input.payload),
  ].join('\n')
}

export type SignInput = {
  readonly secretId: string
  readonly secretKey: string
  readonly host: string
  readonly service: string
  readonly action: string
  readonly version: string
  readonly region?: string
  readonly payload: string
  readonly timestampSec?: number
}

export type SignedRequest = {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export const signRequest = (input: SignInput): SignedRequest => {
  const timestamp = input.timestampSec ?? Math.floor(Date.now() / 1000)
  const date = utcDate(timestamp)
  const scope = `${date}/${input.service}/tc3_request`

  const stringToSign = [
    ALGORITHM,
    String(timestamp),
    scope,
    sha256Hex(canonicalRequest({
      host: input.host, action: input.action, payload: input.payload,
    })),
  ].join('\n')

  const secretDate = hmac(`TC3${input.secretKey}`, date)
  const secretService = hmac(secretDate, input.service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `${ALGORITHM} Credential=${input.secretId}/${scope}, ` +
    `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`

  return {
    url: `https://${input.host}`,
    headers: {
      authorization,
      'content-type': CONTENT_TYPE,
      host: input.host,
      'x-tc-action': input.action,
      'x-tc-timestamp': String(timestamp),
      'x-tc-version': input.version,
      ...(input.region === undefined || input.region === ''
        ? {}
        : { 'x-tc-region': input.region }),
    },
    body: input.payload,
  }
}

export { sha256Hex }
