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
  modelApiKey: process.env.MODEL_API_KEY ?? '',
} as const

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
