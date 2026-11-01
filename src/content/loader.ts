import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { GeofenceDef } from '../context/geofence.js'

/** 锚点八要素 —— 规格 04 §4.5 的运行时契约 */

const voicedSchema = z.object({
  companion: z.string().nullable(),
  child: z.string().nullable(),
  light: z.string().nullable(),
})

/**
 * 一个署名 —— 规格 03 §9.2 的双签，一方一条。
 *
 * `role` 是这个项目里的治理身份（内容负责人 / 外部历史顾问），不是中台的
 * 工作区角色。中台的角色（owner/editor/reviewer/viewer）会随人事变动改，
 * 而签名一旦签下就不该再变；把会变的那个抄进 git，日后只会对不上。
 *
 * `account` 是中台账号的邮箱，而且必须已经是中台自己的规范化形式
 * （`services/api/app/security.py` 的 `normalize_email`：去空白 + 转小写）。
 * 要这么严是为了能直接按 `users.email` 等值查到人——大小写不一致的话，
 * 这条联查会静默查不到，而不是报错。这里只校验形状：邮箱长得对，不等于
 * 中台真有这个账号。真正能核对账号的只有中台自己（见契约第四节）。
 */
const reviewSignerSchema = z.object({
  role: z.enum(['content_owner', 'history_advisor']),
  account: z.string().max(190).regex(
    /^[^@\s]+@[^@\s.]+\.[^@\s]+$/,
    'account 要填中台账号的邮箱',
  ).refine((account) => account === account.toLowerCase(), {
    message: 'account 要用中台的规范化形式（全小写），否则按 users.email 等值查不到人',
  }),
})

/**
 * 双签审校的凭据 —— 规格 03 §9.2。
 *
 * `approved` 是唯一能把史实送进游记的开关（规格 04 §7.1，执行点
 * src/agent/travelogue.ts）。原先这里只校验 status 是枚举之一：署名可以是
 * 空数组、日期可以是 null、待核清单可以非空，照样算「已审校」。自己手写
 * 锚点文件时这无所谓；锚点改由知识库供应链中台产出之后，这就是上游一句
 * 自我声明就能打开的闸（见 content/supply-chain-contract.md 第四节）。
 *
 * 不满足就让 loadAnchors 抛错、整个内容加载失败，不降级跳过那一个锚点：
 * 「静默地少讲」是这个项目认定的最坏结果，契约违反要响，不要悄悄过。
 */
const reviewSchema = z.object({
  status: z.enum(['draft', 'in_review', 'approved']),
  reviewedBy: z.array(reviewSignerSchema),
  reviewedAt: z.string().nullable(),
  factCheckRequired: z.array(z.string()),
  note: z.string().optional(),
}).superRefine((review, ctx) => {
  if (review.status !== 'approved') return

  /*
   * 双签要的是「两方」，不是「两条」：内容负责人签了两次不算双签，
   * 所以两个角色各得有人，而且不能是同一个账号兼任。
   */
  for (const [role, label] of [
    ['content_owner', '内容负责人'],
    ['history_advisor', '外部历史顾问'],
  ] as const) {
    if (!review.reviewedBy.some((signer) => signer.role === role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewedBy'],
        message: `approved 缺${label}的署名（role=${role}，规格 03 §9.2 双签）`,
      })
    }
  }

  const accounts = new Set(review.reviewedBy.map((signer) => signer.account))
  if (accounts.size < review.reviewedBy.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedBy'],
      message: '同一个中台账号不能兼任双签的两方',
    })
  }

  if (review.reviewedAt === null || !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedAt'],
      message: 'approved 需要 YYYY-MM-DD 的审校日期',
    })
  }

  /*
   * 「required」就是未结的活，和 approved 自相矛盾。已签之后仍要带的
   * 常备提示写 note。若中台流程确实需要「已签但保留备注」，改这一条，
   * 不要去放宽 reviewedBy。
   */
  if (review.factCheckRequired.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['factCheckRequired'],
      message: `approved 不能还挂着 ${review.factCheckRequired.length} 条待核项，常备提示请写进 note`,
    })
  }
})

export const anchorSchema = z.object({
  anchorId: z.string(),
  name: z.string(),
  sceneId: z.string(),
  poiId: z.string().optional(),
  exhibitId: z.string().optional(),
  isTop30: z.boolean(),
  topics: z.array(z.string()),
  review: reviewSchema,
  k1Sources: z.array(z.object({
    title: z.string(), publisher: z.string().optional(),
    url: z.string().optional(), fetchedAt: z.string().optional(),
  })),
  elements: z.object({
    openingHook: voicedSchema,
    observation: voicedSchema,
    question: voicedSchema,
    explanation: voicedSchema,
    story: z.string().nullable(),
    connection: z.object({
      curriculum: z.object({ stage: z.string(), ref: z.string() }).nullable(),
      presentDay: z.string().nullable(),
    }),
    memoryLink: z.object({ template: z.string() }),
    nextAction: z.object({ suggest: z.string().nullable(), reason: z.string() }),
  }),
})

export type Anchor = z.infer<typeof anchorSchema>

const CONTENT_DIR = join(import.meta.dirname, '..', '..', 'content')

export const loadAnchors = async (): Promise<ReadonlyMap<string, Anchor>> => {
  const dir = join(CONTENT_DIR, 'anchors')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const entries = await Promise.all(files.map(async (file) => {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
    const parsed = anchorSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`锚点 ${file} 不符合八要素契约：${parsed.error.message}`)
    }
    return [parsed.data.anchorId, parsed.data] as const
  }))
  return new Map(entries)
}

const fenceFileSchema = z.object({
  sceneId: z.string(),
  calibrated: z.boolean(),
  note: z.string().optional(),
  fences: z.array(z.object({
    poiId: z.string(),
    name: z.string(),
    center: z.object({ lat: z.number(), lng: z.number() }),
    radiusM: z.number().positive(),
    exitRadiusM: z.number().positive().optional(),
    minDwellSec: z.number().int().positive().optional(),
    cooldownSec: z.number().int().positive().optional(),
    priority: z.number().int(),
    sceneId: z.string(),
  })),
})

const warnedScenes = new Set<string>()

export const loadGeofences = async (): Promise<readonly GeofenceDef[]> => {
  const dir = join(CONTENT_DIR, 'geofences')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  const groups = await Promise.all(files.map(async (file) => {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
    const parsed = fenceFileSchema.parse(raw)
    if (!parsed.calibrated && !warnedScenes.has(parsed.sceneId)) {
      warnedScenes.add(parsed.sceneId)
      console.warn(`[content] ${parsed.sceneId} 围栏尚未现场校准（规格 02 §9.3）`)
    }
    return parsed.fences
  }))
  return groups.flat()
}

/** 按锚点所属的 poi/exhibit 反查 */
export const anchorForPlace = (
  anchors: ReadonlyMap<string, Anchor>, placeId: string,
): Anchor | null => {
  for (const anchor of anchors.values()) {
    if (anchor.poiId === placeId || anchor.exhibitId === placeId) return anchor
  }
  return null
}

/**
 * 地点索引：poiId / exhibitId → 展示名 + 挂在它上面的锚点。
 *
 * 存在的理由：location_event 记的是 poi_id（如 fzm_jiangnan_gongyuan），
 * interaction 记的是 anchor_id（如 fzm_jiangnan_gongyuan_haoshe）——
 * 两者不是同一个 ID 空间，语义足迹聚合时必须靠这张索引搭桥。
 */
export type PlaceEntry = { readonly name: string; readonly anchorIds: readonly string[] }
export type PlaceIndex = ReadonlyMap<string, PlaceEntry>

export const buildPlaceIndex = async (): Promise<PlaceIndex> => {
  const [anchors, fences] = await Promise.all([loadAnchors(), loadGeofences()])
  const index = new Map<string, { name: string; anchorIds: string[] }>()

  for (const fence of fences) {
    index.set(fence.poiId, { name: fence.name, anchorIds: [] })
  }
  for (const anchor of anchors.values()) {
    const placeId = anchor.poiId ?? anchor.exhibitId
    if (placeId === undefined) continue
    const existing = index.get(placeId)
    if (existing === undefined) {
      index.set(placeId, { name: anchor.name, anchorIds: [anchor.anchorId] })
    } else {
      existing.anchorIds = [...existing.anchorIds, anchor.anchorId]
    }
  }
  return index
}
