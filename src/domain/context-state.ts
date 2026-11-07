import { z } from 'zod'
import { AGE_BANDS, MODES, PARTIES } from './enums.js'

/**
 * Context State —— 规格 02 §6.1 的运行时契约。
 * 这是 02 交给 03 的唯一接口：Planner 看不到商户字段，结构上就调不到（规格 04 §8）。
 */

const levelSchema = z.enum(['low', 'medium', 'high'])

export const familyContextSchema = z.object({
  familyId: z.string(),
  child: z.object({
    userId: z.string(),
    grade: z.string().optional(),
    explainPref: z.record(z.unknown()).default({}),
  }),
  parent: z.object({ userId: z.string() }),
  foregroundUser: z.enum(['child', 'parent']),
})

export const contextStateSchema = z.object({
  user: z.string(),
  mode: z.enum(MODES),
  party: z.enum(PARTIES),
  ageBand: z.enum(AGE_BANDS),

  scene: z.enum(['indoor', 'outdoor']),
  sceneId: z.string(),
  location: z.string().nullable(),
  locationSource: z.enum(['geofence', 'user_confirmed', 'vision_anchor', 'inferred', 'none']),
  locationConfidence: z.number().min(0).max(1),

  activity: z.enum(['still', 'walking', 'fast_moving']),
  isMoving: z.boolean(),
  isDining: z.boolean(),
  accuracyM: z.number().nullable(),

  currentTopic: z.string().nullable(),
  interest: levelSchema,
  fatigue: levelSchema,
  dwellHereSec: z.number().int().min(0),
  elapsedMin: z.number().int().min(0),
  timeLeft: z.number().int().nullable(),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']),

  nextGoal: z.string().nullable(),
  routeRemaining: z.array(z.string()),
  activeTask: z.object({ taskId: z.string(), stage: z.string() }).nullable(),

  // 来自规格 01 的记忆注入（01 附录 A）
  memoryHooks: z.array(z.string()),
  identityTraits: z.array(z.string()),
  preferences: z.record(z.string()),
  visitedAnchors: z.array(z.string()),

  lastSpokeSecAgo: z.number().int().nullable(),
  /**
   * 上一次**主动开口**距今多少秒。规格 02 §7.4 的最大主动频次只数它：
   * 回答用户提问不算（那不是主动），出一张静默卡片也不算（它没出声）。
   * 这趟还没主动开口过是 null。
   */
  lastProactiveSecAgo: z.number().int().nullable(),
  /**
   * 本次旅程**主动开口**的次数。规格 02 §7.3 第 7 行的频次扣分数它，
   * 口径和 lastProactiveSecAgo 完全一致：回答提问不算，静默卡片不算。
   */
  proactiveCount: z.number().int().min(0),
  consecutiveIgnored: z.number().int().min(0),
  userIsSpeaking: z.boolean(),

  journeyId: z.string(),
  stateVersion: z.literal(1),
  computedAt: z.string(),

  family: familyContextSchema.optional(),
})

export type ContextState = z.infer<typeof contextStateSchema>
export type FamilyContext = z.infer<typeof familyContextSchema>
