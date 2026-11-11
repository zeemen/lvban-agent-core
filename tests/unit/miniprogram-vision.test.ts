import { describe, expect, test, vi } from 'vitest'
import { createClient, type RequestFn, type RequestOptions } from '../../miniprogram/utils/api'
import { MAX_UPLOAD_BYTES, capturePhoto, type PhotoDeps } from '../../miniprogram/utils/photo'

/**
 * 「拍一下」的客户端两端：拍照取图、以及打到服务端的三个请求。
 * request 与 wx 的几个异步能力都可注入，所以不开模拟器就能测。
 */

const jsonRequest = (body: unknown): { request: RequestFn; calls: RequestOptions[] } => {
  const calls: RequestOptions[] = []
  const request: RequestFn = (options) => {
    calls.push(options)
    queueMicrotask(() => options.success?.({ statusCode: 200, data: body }))
    return { abort: () => undefined }
  }
  return { request, calls }
}

const base64Of = (bytes: number): string => Buffer.alloc(bytes, 0x41).toString('base64')

const deps = (over: Partial<PhotoDeps> = {}): PhotoDeps => ({
  choose: async () => ({ tempFilePath: 'wxfile://a.jpg', size: 1024 }),
  compress: async () => ({ tempFilePath: 'wxfile://small.jpg', size: 2048 }),
  readBase64: async () => base64Of(1024),
  ...over,
})

describe('capturePhoto —— 规格 02 §4.2 的前端压缩要求', () => {
  test('没超限就不白压一遍', async () => {
    const compress = vi.fn()

    const got = await capturePhoto(deps({ compress }))

    expect(compress).not.toHaveBeenCalled()
    expect(got.imageKey.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(got.compressed).toBe(false)
  })

  test('超限就压一次，并且用压过的那张', async () => {
    const compress = vi.fn(async () => ({ tempFilePath: 'wxfile://small.jpg', size: 4096 }))
    const readBase64 = vi.fn(async (path: string) =>
      path === 'wxfile://small.jpg' ? base64Of(4096) : base64Of(MAX_UPLOAD_BYTES + 1))

    const got = await capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://big.jpg', size: MAX_UPLOAD_BYTES + 1 }),
      compress, readBase64,
    }))

    expect(compress).toHaveBeenCalledOnce()
    expect(got.compressed).toBe(true)
    expect(got.bytes).toBe(4096)
  })

  /*
   * 压过还是超限：必须在这里报错，不能发出去。
   * 服务端那道 300KB 闸现在也拦 data URI 了，但报错会出现在「按下快门之后」，
   * 而且是一条模型适配层的话——不如在本地说清楚。
   */
  test('压过仍然超限就报错，并把实际大小说出来', async () => {
    const over = MAX_UPLOAD_BYTES + 50 * 1024

    await expect(capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://big.jpg', size: over }),
      compress: async () => ({ tempFilePath: 'wxfile://still-big.jpg', size: over }),
      readBase64: async () => base64Of(over),
    }))).rejects.toThrow(/KB/)
  })

  test('bytes 报的是解码后的字节数，不是 base64 串长', async () => {
    const got = await capturePhoto(deps({ readBase64: async () => base64Of(3000) }))

    expect(got.bytes).toBe(3000)
    expect(got.imageKey.length).toBeGreaterThan(3000)
  })

  test('用户取消拍照时，错误原样抛出，不吞成「识别失败」', async () => {
    await expect(capturePhoto(deps({
      choose: async () => { throw new Error('cancel') },
    }))).rejects.toThrow('cancel')
  })
})

describe('视觉相关的三个请求', () => {
  test('visionAnchor 打到 /v1/vision/anchor，带 journeyId 与 imageKey', async () => {
    const { request, calls } = jsonRequest({ decision: 'auto_accept', candidates: [] })

    await createClient({ baseUrl: 'https://x.test', request })
      .visionAnchor({ journeyId: 'j1', imageKey: 'data:image/jpeg;base64,AAA' })

    expect(calls[0]?.url).toBe('https://x.test/v1/vision/anchor')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.data).toEqual({
      journeyId: 'j1', imageKey: 'data:image/jpeg;base64,AAA',
    })
  })

  test('zoneHint 给了才带，没给不能发一个 undefined 字段', async () => {
    const { request, calls } = jsonRequest({ decision: 'auto_accept', candidates: [] })

    await createClient({ baseUrl: 'https://x.test', request })
      .visionAnchor({ journeyId: 'j1', imageKey: 'k', zoneHint: 'nanjing_museum' })

    expect(calls[0]?.data).toEqual({ journeyId: 'j1', imageKey: 'k', zoneHint: 'nanjing_museum' })
  })

  test('visionOutcome 打到 /outcome 并原样转交负载', async () => {
    const { request, calls } = jsonRequest({ samples: 1, hitRate: 1, fallbackActive: false })

    await createClient({ baseUrl: 'https://x.test', request })
      .visionOutcome({ corrected: true, journeyId: 'j1', locationEventId: 'evt-1' })

    expect(calls[0]?.url).toBe('https://x.test/v1/vision/anchor/outcome')
    expect(calls[0]?.data).toEqual({ corrected: true, journeyId: 'j1', locationEventId: 'evt-1' })
  })

  /*
   * 室内落位必须自报来源（规格 02 §4.1 四件套）。不报就只能算 inferred，
   * 置信度按推断打折——拍一下认出来的点位会因此被当成猜的。
   */
  test('arrive 能带上位置来源与置信度', async () => {
    const { request, calls } = jsonRequest({ spoke: true, text: '', decision: 'SPEAK' })

    await createClient({ baseUrl: 'https://x.test', request }).arrive('j1', 'njm_cuojinyin_hu', {
      locationSource: 'vision_anchor', locationConfidence: 0.82,
    })

    expect(calls[0]?.data).toEqual({
      poiId: 'njm_cuojinyin_hu', locationSource: 'vision_anchor', locationConfidence: 0.82,
    })
  })

  test('不带来源时请求体和以前一样，围栏那条路不受影响', async () => {
    const { request, calls } = jsonRequest({ spoke: true, text: '', decision: 'SPEAK' })

    await createClient({ baseUrl: 'https://x.test', request }).arrive('j1', 'fzm_wende_qiao')

    expect(calls[0]?.data).toEqual({ poiId: 'fzm_wende_qiao' })
  })
})
