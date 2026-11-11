import { describe, expect, test, vi } from 'vitest'
import { createClient, type RequestFn, type RequestOptions } from '../../miniprogram/utils/api'
import {
  MAX_UPLOAD_BYTES, QUALITY_LADDER, capturePhoto, type PhotoDeps,
} from '../../miniprogram/utils/photo'

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
    const compress = vi.fn(async (_input: { src: string; quality: number }) =>
      ({ tempFilePath: 'wxfile://small.jpg', size: 4096 }))
    const readBase64 = vi.fn(async (path: string) =>
      path === 'wxfile://small.jpg' ? base64Of(4096) : base64Of(MAX_UPLOAD_BYTES + 1))

    const got = await capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://big.jpg', size: MAX_UPLOAD_BYTES + 1 }),
      compress, readBase64,
    }))

    expect(compress).toHaveBeenCalledOnce()
    expect(compress.mock.calls[0]?.[0]).toMatchObject({ quality: QUALITY_LADDER[0] })
    expect(got.compressed).toBe(true)
    expect(got.bytes).toBe(4096)
  })

  /*
   * 300KB 这道闸比看上去紧。2026-11-10 实测：真实照片缩到长边 1280、q=80
   * 之后是 187KB 与 236KB——后者已经用掉上限的 78%。展厅里纹理更多
   * （人群、织锦、玻璃反光），越过 300KB 是会发生的。
   *
   * 所以不能压一次就放弃：q=80 不够时降到 60（实测同一张 236KB → 157KB），
   * 再不够降到 45（→ 114KB）。每一档都从原图压，不是拿压过的再压一遍——
   * 二次压缩只会多掉一次画质，省不了多少字节。
   */
  test('一档不够就降一档，用第一个压到位的结果', async () => {
    const sizes: Record<number, number> = {
      80: MAX_UPLOAD_BYTES + 40 * 1024,
      60: 160 * 1024,
      45: 110 * 1024,
    }
    const compress = vi.fn(async (input: { src: string; quality: number }) => ({
      tempFilePath: `wxfile://q${input.quality}.jpg`, size: sizes[input.quality] ?? 0,
    }))
    const readBase64 = vi.fn(async (path: string) => {
      const q = Number(/q(\d+)\.jpg/.exec(path)?.[1] ?? 0)
      return base64Of(sizes[q] ?? MAX_UPLOAD_BYTES + 1)
    })

    const got = await capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://big.jpg', size: MAX_UPLOAD_BYTES + 99 }),
      compress, readBase64,
    }))

    expect(compress).toHaveBeenCalledTimes(2)
    expect(compress.mock.calls.map((c) => c[0].quality)).toEqual([80, 60])
    expect(got.bytes).toBe(160 * 1024)
    expect(got.quality).toBe(60)
  })

  test('每一档都从原图压，不是拿压过的再压一遍', async () => {
    const compress = vi.fn(async (_input: { src: string; quality: number }) => ({
      tempFilePath: 'wxfile://out.jpg', size: MAX_UPLOAD_BYTES + 1,
    }))

    await capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://origin.jpg', size: MAX_UPLOAD_BYTES + 1 }),
      compress,
      readBase64: async () => base64Of(MAX_UPLOAD_BYTES + 1),
    })).catch(() => undefined)

    for (const call of compress.mock.calls) {
      expect(call[0].src).toBe('wxfile://origin.jpg')
    }
  })

  /*
   * 整条阶梯走完还是超限：必须在这里报错，不能发出去。
   * 服务端那道 300KB 闸现在也拦 data URI 了，但报错会出现在「按下快门之后」，
   * 而且是一条模型适配层的话——不如在本地说清楚。
   */
  test('整条阶梯走完仍然超限才报错，并把实际大小说出来', async () => {
    const over = MAX_UPLOAD_BYTES + 50 * 1024
    const compress = vi.fn(async () => ({ tempFilePath: 'wxfile://still-big.jpg', size: over }))

    await expect(capturePhoto(deps({
      choose: async () => ({ tempFilePath: 'wxfile://big.jpg', size: over }),
      compress,
      readBase64: async () => base64Of(over),
    }))).rejects.toThrow(/KB/)
    expect(compress).toHaveBeenCalledTimes(QUALITY_LADDER.length)
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
