import { describe, expect, test } from 'vitest'
import {
  canonicalRequest, sha256Hex, signRequest, utcDate,
} from '../../src/tencent/sign.js'

/**
 * TC3-HMAC-SHA256 签名。
 *
 * 官方文档的示例把密钥掩码了，但**规范请求哈希和载荷哈希是明文给出的**，
 * 所以最容易出错的那一段可以离线锁死。签名算错时服务端只回一句
 * `AuthFailure.SignatureFailure`，没有这组向量就只能靠猜。
 *
 * 向量来源：cloud.tencent.com/document/api/1073/30636
 */

const DOC_PAYLOAD =
  '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}'
const DOC_PAYLOAD_HASH =
  '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064'
const DOC_CANONICAL_HASH =
  '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84'

describe('官方文档测试向量', () => {
  test('载荷哈希与文档一致', () => {
    expect(sha256Hex(DOC_PAYLOAD)).toBe(DOC_PAYLOAD_HASH)
  })

  test('规范请求逐字节与文档一致', () => {
    const cr = canonicalRequest({
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      payload: DOC_PAYLOAD,
    })

    expect(cr).toBe([
      'POST', '/', '',
      'content-type:application/json; charset=utf-8',
      'host:cvm.tencentcloudapi.com',
      'x-tc-action:describeinstances',
      '',
      'content-type;host;x-tc-action',
      DOC_PAYLOAD_HASH,
    ].join('\n'))
  })

  test('规范请求哈希与文档一致 —— 这一步错了签名必错', () => {
    const cr = canonicalRequest({
      host: 'cvm.tencentcloudapi.com',
      action: 'DescribeInstances',
      payload: DOC_PAYLOAD,
    })

    expect(sha256Hex(cr)).toBe(DOC_CANONICAL_HASH)
  })
})

describe('规范请求的易错细节', () => {
  test('x-tc-action 在签名里必须小写', () => {
    const cr = canonicalRequest({
      host: 'tts.tencentcloudapi.com', action: 'TextToVoice', payload: '{}',
    })

    expect(cr).toContain('x-tc-action:texttovoice')
    expect(cr).not.toContain('x-tc-action:TextToVoice')
  })

  test('content-type 必须与实际发送的完全一致', () => {
    const cr = canonicalRequest({ host: 'h', action: 'A', payload: '{}' })

    expect(cr).toContain('content-type:application/json; charset=utf-8')
  })

  test('载荷任何变化都会改变规范请求', () => {
    const a = canonicalRequest({ host: 'h', action: 'A', payload: '{"a":1}' })
    const b = canonicalRequest({ host: 'h', action: 'A', payload: '{"a":2}' })

    expect(a).not.toBe(b)
  })
})

describe('utcDate', () => {
  test('按 UTC 取日期，不受本地时区影响', () => {
    // 2019-02-25T16:44:25Z；在东八区这是 26 日凌晨，用本地时区就会签错
    expect(utcDate(1551113065)).toBe('2019-02-25')
  })

  test('UTC 当日最后一秒仍算当天', () => {
    expect(utcDate(Date.UTC(2026, 9, 25, 23, 59, 59) / 1000)).toBe('2026-10-25')
  })
})

describe('signRequest', () => {
  const base = {
    secretId: 'AKIDtest', secretKey: 'secrettest',
    host: 'tts.tencentcloudapi.com', service: 'tts',
    action: 'TextToVoice', version: '2019-08-23',
    payload: '{"Text":"你好"}', timestampSec: 1551113065,
  }

  test('Authorization 的三段结构齐全', () => {
    const signed = signRequest(base)

    expect(signed.headers.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDtest\/2019-02-25\/tts\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    )
  })

  test('必需的 X-TC-* 头都带上了', () => {
    const signed = signRequest({ ...base, region: 'ap-guangzhou' })

    expect(signed.headers['x-tc-action']).toBe('TextToVoice')
    expect(signed.headers['x-tc-version']).toBe('2019-08-23')
    expect(signed.headers['x-tc-timestamp']).toBe('1551113065')
    expect(signed.headers['x-tc-region']).toBe('ap-guangzhou')
  })

  test('没有 region 时不发这个头', () => {
    expect(signRequest(base).headers['x-tc-region']).toBeUndefined()
  })

  test('同样输入得到同样签名（可复现）', () => {
    expect(signRequest(base).headers.authorization)
      .toBe(signRequest(base).headers.authorization)
  })

  test.each([
    ['密钥', { secretKey: 'other' }],
    ['载荷', { payload: '{"Text":"别的"}' }],
    ['时间戳', { timestampSec: 1551113066 }],
    ['动作', { action: 'OtherAction' }],
  ])('%s 变了签名就变', (_label, patch) => {
    expect(signRequest({ ...base, ...patch }).headers.authorization)
      .not.toBe(signRequest(base).headers.authorization)
  })

  test('body 原样返回，保证发送内容与签名内容一致', () => {
    const signed = signRequest(base)

    expect(signed.body).toBe(base.payload)
  })

  test('不传时间戳时用当前时间，且在五分钟容差内', () => {
    const signed = signRequest({ ...base, timestampSec: undefined })
    const drift = Math.abs(Number(signed.headers['x-tc-timestamp']) - Date.now() / 1000)

    expect(drift).toBeLessThan(5)
  })
})
