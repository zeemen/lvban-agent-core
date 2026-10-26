import 'dotenv/config'

const required = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`缺少必需的环境变量：${key}（参考 .env.example）`)
  }
  return value
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  port: Number(required('PORT', '8787')),
  modelProvider: required('MODEL_PROVIDER', 'mock'),
  /** 覆盖供应商档案里的 baseUrl（如百炼的业务空间专属域名） */
  modelBaseUrl: process.env.MODEL_BASE_URL,
} as const

/**
 * API Key 解析：优先供应商专属环境变量（DASHSCOPE_API_KEY 等），
 * 其次通用的 MODEL_API_KEY。这样同时配多家时互不冲突。
 */
export const resolveApiKey = (
  apiKeyEnv: string, env: NodeJS.ProcessEnv = process.env,
): string => env[apiKeyEnv] ?? env.MODEL_API_KEY ?? ''

/**
 * 按任务挑供应商：MODEL_PROVIDER_<TASK> 优先，MODEL_PROVIDER 兜底。
 *
 * 存在的理由：视觉和文本的最优供应商未必是同一家。
 * 例如文本走 DeepSeek、视觉走通义千问的 qwen-vl-max——
 * 规格 03 §7 的 Model Router 本来就是「不绑定单一模型」。
 */
export const resolveProviderFor = (
  task: string, env: NodeJS.ProcessEnv = process.env,
): string => {
  const override = env[`MODEL_PROVIDER_${task.toUpperCase()}`]
  if (override !== undefined && override !== '') return override
  return env.MODEL_PROVIDER ?? 'mock'
}

/** 规格 01 §4.3：蒸馏阈值全部外置，待真实数据校准 */
export const distillation = {
  d2SignalCountMin: 2,
  d2DwellSecAsSignal: 300,
  d3JourneyCountMin: 3,
  d3RequirePartyInvariant: true,
  d4RawTrackTtlDays: 7,
  preferenceDecayHalfLifeDays: 180,
  preferenceDecayFloor: 0.2,
} as const

/** 规格 02 §2–3：采样与围栏 */
export const location = {
  maxAccuracyM: 50,
  trustedAccuracyM: 25,
  geofenceDefaultRadiusM: 25,
  geofenceExitMarginM: 15,
  geofenceMinDwellSec: 20,
  geofenceCooldownSec: 1800,
  fastMovingSpeedMps: 3.0,
  stopWindowSec: 180,
  stopRadiusM: 30,
} as const

/** 规格 02 §4：室内视觉锚点 */
export const vision = {
  tauHigh: 0.75,
  tauLow: 0.45,
  hitRateWindow: 200,
  hitRateThreshold: 0.8,
} as const

/** 规格 01 §5.1：行中检索预算 */
export const retrieval = {
  inJourneyMaxHooks: 6,
  inJourneyMaxTokens: 600,
  prePlanningMaxHooks: 10,
  postJourneyMaxHooks: 30,
} as const
