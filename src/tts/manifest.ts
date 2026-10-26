import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CACHE_DIR } from './cache.js'

/**
 * 预合成清单。
 *
 * 为什么需要它：固定台词用的是稳定路径（fillers/peer_q_01.mp3），路径里不含
 * 供应商和音色。只看「文件存在就跳过」的话，用 mock 预合成过一轮之后换上真
 * 供应商，presynth 会全部跳过——线上播的就是假音频，而且不会有任何报错。
 *
 * 清单记下每条音频是**用谁、用什么音色、什么语速**合成的，
 * 任何一项对不上就重新合成。
 */

const entrySchema = z.object({
  provider: z.string(),
  voice: z.string(),
  speedRatio: z.number(),
  text: z.string(),
  bytes: z.number(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
})

const manifestSchema = z.record(entrySchema)

export type ManifestEntry = z.infer<typeof entrySchema>
export type Manifest = Record<string, ManifestEntry>

const MANIFEST_PATH = join(CACHE_DIR, 'manifest.json')

export const loadManifest = async (): Promise<Manifest> => {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export const saveManifest = async (manifest: Manifest): Promise<void> => {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

export type FreshnessInput = {
  readonly provider: string
  readonly voice: string
  readonly speedRatio: number
  readonly text: string
}

/** 这条已有音频还能用吗 */
export const isFresh = (
  entry: ManifestEntry | undefined, want: FreshnessInput,
): boolean =>
  entry !== undefined &&
  entry.provider === want.provider &&
  entry.voice === want.voice &&
  entry.speedRatio === want.speedRatio &&
  entry.text === want.text

/** 为什么要重新合成，说人话 */
export const stalenessReason = (
  entry: ManifestEntry | undefined, want: FreshnessInput,
): string => {
  if (entry === undefined) return '清单里没有记录'
  if (entry.provider !== want.provider) return `供应商变了（${entry.provider} → ${want.provider}）`
  if (entry.voice !== want.voice) return `音色变了（${entry.voice} → ${want.voice}）`
  if (entry.speedRatio !== want.speedRatio) {
    return `语速变了（${entry.speedRatio} → ${want.speedRatio}）`
  }
  if (entry.text !== want.text) return '文案变了'
  return ''
}
