/**
 * 拍照取图 —— 规格 02 §4.2「前端压缩（长边 ≤1280px，JPEG q=0.8，目标 <300KB）」。
 *
 * §4.2 原本写的是「上传（HTTPS，直传对象存储，回传 key）」。对象存储还没有，
 * 所以这里把图片做成 data URI 直接当 imageKey 交给服务端——服务端的
 * `src/models/image-url.ts` 两种形式都认。两点代价要记住：
 *   1. base64 比原字节多约三分之一，请求体也就大三分之一；
 *   2. 图片经过我们自己的服务，不是客户端直传。
 * 上线前这一段要换成直传，接口不用动（imageKey 换成对象存储回传的 key）。
 *
 * wx 的几个异步能力都从 deps 注入，所以这一层不开模拟器也能测。
 */

export const MAX_UPLOAD_BYTES = 300 * 1024
export const LONG_EDGE_PX = 1280
export const JPEG_QUALITY = 80

export type ChosenFile = {
  readonly tempFilePath: string
  readonly size: number
}

export type PhotoDeps = {
  /** 拉起相机或相册，拿一张图 */
  readonly choose: () => Promise<ChosenFile>
  readonly compress: (input: {
    readonly src: string
    readonly quality: number
    readonly compressedWidth?: number
  }) => Promise<ChosenFile>
  /** 读成 base64 字符串（不含 data: 前缀） */
  readonly readBase64: (path: string) => Promise<string>
}

export type CapturedPhoto = {
  /** 直接可交给 /v1/vision/anchor 的 imageKey */
  readonly imageKey: string
  /** 解码后的字节数，不是 base64 串长 */
  readonly bytes: number
  readonly compressed: boolean
}

/** base64 串长反推解码字节数，省得为了量个大小再解一遍 */
const decodedBytes = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length / 4) * 3 - padding
}

const kb = (bytes: number): number => Math.round(bytes / 1024)

/**
 * 取一张压到 300KB 以内的照片。
 *
 * 只压一次：chooseMedia 已经按 `sizeType: ['compressed']` 出图，还超限说明
 * 原图特别大，再反复压下去用户只会一直等。此时报错而不是硬发——
 * 发出去也会被服务端那道闸拦掉，只是错误要晚几秒、还是一条模型适配层的话。
 */
export const capturePhoto = async (deps: PhotoDeps): Promise<CapturedPhoto> => {
  const chosen = await deps.choose()
  if (chosen.size <= MAX_UPLOAD_BYTES) {
    const base64 = await deps.readBase64(chosen.tempFilePath)
    return {
      imageKey: `data:image/jpeg;base64,${base64}`,
      bytes: decodedBytes(base64),
      compressed: false,
    }
  }

  const smaller = await deps.compress({
    src: chosen.tempFilePath,
    quality: JPEG_QUALITY,
    compressedWidth: LONG_EDGE_PX,
  })
  const base64 = await deps.readBase64(smaller.tempFilePath)
  const bytes = decodedBytes(base64)
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `这张照片压到 ${kb(bytes)}KB 还是超过 ${kb(MAX_UPLOAD_BYTES)}KB，`
      + '换个角度离近一点再拍一张',
    )
  }
  return { imageKey: `data:image/jpeg;base64,${base64}`, bytes, compressed: true }
}

/* ─────────────────────── 下面是 wx 那一侧的接线 ─────────────────────── */

type WxLike = {
  chooseMedia(options: Record<string, unknown>): void
  compressImage(options: Record<string, unknown>): void
  getFileSystemManager(): {
    readFile(options: Record<string, unknown>): void
  }
}

const wxOf = (): WxLike => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (g.wx?.chooseMedia === undefined) {
    throw new Error('不在小程序环境中：请注入 PhotoDeps')
  }
  return g.wx as WxLike
}

/** 把 wx 的回调式 API 包成 Promise；失败原样抛出（用户取消也是失败） */
export const wxPhotoDeps = (): PhotoDeps => {
  const wx = wxOf()
  return {
    choose: () => new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed'],
        camera: 'back',
        success: (res: { tempFiles: readonly ChosenFile[] }) => {
          const file = res.tempFiles[0]
          if (file === undefined) reject(new Error('没有取到照片'))
          else resolve(file)
        },
        fail: (err: { errMsg: string }) => reject(new Error(err.errMsg)),
      })
    }),
    compress: (input) => new Promise((resolve, reject) => {
      wx.compressImage({
        src: input.src,
        quality: input.quality,
        compressedWidth: input.compressedWidth,
        success: (res: { tempFilePath: string; size?: number }) => resolve({
          tempFilePath: res.tempFilePath,
          // compressImage 不保证回 size；回不了就按「还得量一次」走，
          // 真实大小由 readBase64 之后的 decodedBytes 决定
          size: res.size ?? 0,
        }),
        fail: (err: { errMsg: string }) => reject(new Error(err.errMsg)),
      })
    }),
    readBase64: (path) => new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'base64',
        success: (res: { data: string }) => resolve(res.data),
        fail: (err: { errMsg: string }) => reject(new Error(err.errMsg)),
      })
    }),
  }
}
