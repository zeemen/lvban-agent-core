import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Register } from '../planner/decide.js'

/**
 * 预置垫音 —— 规格 03 §7 的首字延迟对策。
 *
 * 为什么需要它：实测关掉深度思考后首个正文 delta 仍要约 1.2 秒。
 * 用户按下快门或问完问题，这 1 秒的静默足够让注意力转移。
 * 垫音是本地/CDN 上预合成的固定音频，零延迟播放，刚好盖住这段空白。
 *
 * 它不是「假装在思考」的话术：台词短、不承诺内容，说完就接真正的回答。
 */

const fillerSchema = z.object({
  id: z.string(),
  situation: z.enum(['question', 'photo', 'arrive']),
  text: z.string().min(1).max(20),
  audioKey: z.string(),
})

const fileSchema = z.object({
  register: z.enum(['peer', 'storyteller', 'concise']),
  note: z.string().optional(),
  fillers: z.array(fillerSchema).min(1),
})

export type Filler = z.infer<typeof fillerSchema> & { readonly register: Register }
export type Situation = Filler['situation']

const CONTENT_DIR = join(import.meta.dirname, '..', '..', 'content', 'fillers')

let cache: readonly Filler[] | null = null

export const loadFillers = async (): Promise<readonly Filler[]> => {
  if (cache !== null) return cache
  const files = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith('.json'))
  const groups = await Promise.all(files.map(async (file) => {
    const raw = JSON.parse(await readFile(join(CONTENT_DIR, file), 'utf8'))
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`垫音文件 ${file} 格式不符：${parsed.error.message}`)
    }
    return parsed.data.fillers.map((f) => ({ ...f, register: parsed.data.register }))
  }))
  cache = groups.flat()
  return cache
}

/**
 * 挑一条垫音。
 *
 * 同一条反复出现会非常刺耳，所以排除上一次用过的那条；
 * 只剩一条可选时宁可重复，也不要沉默。
 */
export const pickFiller = (
  all: readonly Filler[],
  input: {
    readonly register: Register
    readonly situation: Situation
    readonly lastUsedId?: string | null
    readonly random?: () => number
  },
): Filler | null => {
  const matching = all.filter(
    (f) => f.register === input.register && f.situation === input.situation,
  )
  if (matching.length === 0) return null

  const candidates = matching.length > 1 && input.lastUsedId != null
    ? matching.filter((f) => f.id !== input.lastUsedId)
    : matching
  const pool = candidates.length > 0 ? candidates : matching

  const random = input.random ?? Math.random
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length))
  return pool[index] ?? null
}
