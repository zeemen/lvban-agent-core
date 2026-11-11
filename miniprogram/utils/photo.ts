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

/**
 * 压缩质量阶梯。规格 02 §4.2 写的是 q=0.8，这里把它当成**第一档**而不是唯一一档。
 *
 * 300KB 这道闸比看上去紧。2026-11-10 用真实照片实测（长边 1280）：
 *   q=80 → 187KB / 236KB（后者已用掉上限的 78%）
 *   q=60 → 157KB（52%）
 *   q=45 → 114KB（37%）
 * 展厅里纹理比风景照更多（人群、织锦、玻璃反光），越过 300KB 是会发生的。
 * 压一次就放弃的话，用户只会看到「再拍一张」——而下一张一样大，这是个死胡同。
 */
export const QUALITY_LADDER: readonly number[] = [80, 60, 45]

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
  /** 实际用到的那一档质量；没压过则为 null */
  readonly quality: number | null
}

/** base64 串长反推解码字节数，省得为了量个大小再解一遍 */
const decodedBytes = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length / 4) * 3 - padding
}

const kb = (bytes: number): number => Math.round(bytes / 1024)

const asImageKey = (base64: string): string => `data:image/jpeg;base64,${base64}`

/**
 * 取一张压到 300KB 以内的照片。
 *
 * chooseMedia 已经按 `sizeType: ['compressed']` 出图，够小就直接用，不白压一遍。
 * 超限则沿 QUALITY_LADDER 逐档降，每一档都**从原图**压：拿压过的再压一遍
 * 只会多掉一次画质，省不了多少字节。
 *
 * 整条阶梯走完还超限才报错，而不是硬发出去——发出去也会被服务端那道闸拦掉，
 * 只是错误要晚几秒、还是一条模型适配层的话。
 */
export const capturePhoto = async (deps: PhotoDeps): Promise<CapturedPhoto> => {
  const chosen = await deps.choose()
  if (chosen.size <= MAX_UPLOAD_BYTES) {
    const base64 = await deps.readBase64(chosen.tempFilePath)
    return {
      imageKey: asImageKey(base64),
      bytes: decodedBytes(base64),
      compressed: false,
      quality: null,
    }
  }

  let last = 0
  for (const quality of QUALITY_LADDER) {
    const smaller = await deps.compress({
      src: chosen.tempFilePath, quality, compressedWidth: LONG_EDGE_PX,
    })
    const base64 = await deps.readBase64(smaller.tempFilePath)
    const bytes = decodedBytes(base64)
    if (bytes <= MAX_UPLOAD_BYTES) {
      return { imageKey: asImageKey(base64), bytes, compressed: true, quality }
    }
    last = bytes
  }

  throw new Error(
    `这张照片压到 ${kb(last)}KB 还是超过 ${kb(MAX_UPLOAD_BYTES)}KB，`
    + '离近一点、少框进一些背景再拍一张',
  )
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
