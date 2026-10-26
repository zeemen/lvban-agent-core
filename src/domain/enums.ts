/**
 * 四份规格共用的全局枚举（specs/README.md「全局约定」）。
 * 改这里之前先改规格——契约漂移是这套系统最容易腐烂的地方。
 */

export const MODES = ['companion', 'family_study', 'light_guide'] as const
export type Mode = (typeof MODES)[number]

export const AGE_BANDS = ['under_12', '12_15', '16_18', '19_24', '25_plus', 'unknown'] as const
export type AgeBand = (typeof AGE_BANDS)[number]

export const PARTIES = ['solo', 'parent_child', 'friends', 'group'] as const
export type Party = (typeof PARTIES)[number]

export const TRACK_CONSENTS = ['none', 'visited_points_only', 'full_track'] as const
export type TrackConsent = (typeof TRACK_CONSENTS)[number]

export const JOURNEY_STATES = [
  'CONSENT', 'DECLINED', 'ACTIVE', 'IDLE',
  'AUTO_ENDED', 'ENDED', 'DISTILLING', 'CLOSED', 'PURGED',
] as const
export type JourneyState = (typeof JOURNEY_STATES)[number]

/** 规格 01 §3.3：provenance。注意 L2/L3 永不接受 system_inferred */
export const MEMORY_SOURCES = ['explicit', 'user_confirmed', 'system_inferred'] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export const PROMOTABLE_SOURCES = ['explicit', 'user_confirmed'] as const
export type PromotableSource = (typeof PROMOTABLE_SOURCES)[number]

/** 规格 01 §2.4：偏好维度封闭集合，不允许运行时造维度 */
export const PREFERENCE_DIMENSIONS = [
  'topic_interest', 'pace', 'depth', 'queue_tolerance',
  'time_of_day', 'party_default', 'explain_style', 'voice_pref',
] as const
export type PreferenceDimension = (typeof PREFERENCE_DIMENSIONS)[number]

/** 规格 01 §3.2：写入黑名单 */
export const BLOCKED_CATEGORIES = [
  'health', 'finance', 'sensitive_identity', 'precise_home', 'inferred_portrait',
] as const
export type BlockedCategory = (typeof BLOCKED_CATEGORIES)[number]

export const SCENE_IDS = ['nanjing_museum', 'fuzimiao'] as const
export type SceneId = (typeof SCENE_IDS)[number]

export type Scene = 'indoor' | 'outdoor'
export type Level = 'low' | 'medium' | 'high'
export type ProactivityDecision = 'SPEAK' | 'SOFT_HINT' | 'SILENT'
