import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 音频缓存 —— 规格 03 §7.2 的缓存策略。
 *
 * 固定台词（垫音、Top 30 锚点的开场段）每个孩子听到的都一样，
 * 第一次合成后就该永久复用：零延迟、零成本。
 * 只有针对随机提问的回答才实时合成。
 *
 * 本地用文件系统；生产换对象存储 + CDN 时只需替换 read/write 两个函数。
 */

const CACHE_DIR = join(import.meta.dirname, '..', '..', 'audio-cache')

export type CacheKeyInput = {
  readonly provider: string
  readonly voice: string
  readonly text: string
  readonly encoding: string
  readonly speedRatio: number
}

/**
 * 内容寻址：同样的文本 + 同样的音色参数 → 同一个文件。
 * 改了音色或语速会自然产生新 key，不会读到旧音频。
 */
export const cacheKey = (input: CacheKeyInput): string => {
  const canonical = [
    input.provider, input.voice, input.encoding,
    input.speedRatio.toFixed(2), input.text,
  ].join('\u0000')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}

export const cachePath = (key: string, encoding: string): string =>
  join(CACHE_DIR, `${key}.${encoding}`)

/** 预合成的固定台词用作者指定的稳定路径（如 fillers/peer_q_01.mp3），不用哈希 */
export const namedPath = (audioKey: string): string => join(CACHE_DIR, audioKey)

export const readCached = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

export const writeCached = async (path: string, audio: Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, audio)
}

export const cachedSize = async (path: string): Promise<number | null> => {
  try {
    const info = await stat(path)
    return info.size
  } catch {
    return null
  }
}

export { CACHE_DIR }
