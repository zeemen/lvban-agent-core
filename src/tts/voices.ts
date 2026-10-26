import type { Register } from '../planner/decide.js'

/**
 * 音色配置 —— 和模型 ID 一样刻意不写死。
 *
 * 各家音色体系完全不同：腾讯云是整数 ID（控制台「音色列表」里查），
 * 火山是字符串代号。两家的音色都要在控制台开通授权才能调用，
 * 所以这里只给「形状」和明确标注的占位值，真实代号由使用者按账号填。
 *
 * 三副面孔对应三种音色（企划书第 03 节）：
 *   peer        同游搭子 —— 年轻、平等、不播音腔
 *   storyteller 六朝书童 —— 少年感、有情绪起伏（优先选支持情感参数的音色）
 *   concise     轻导览   —— 中性、克制
 */

export type VoiceConfig = {
  readonly voice: string
  readonly speedRatio: number
}

/**
 * 占位音色：**未经核实**，只为让链路在没配置时也能跑起来。
 * presynth 和 probe 都会就此告警，上线前必须换成账号实际授权的代号。
 */
const PLACEHOLDER_VOICE: Record<string, string> = {
  tencent: '101001',
  volcengine: 'BV001_streaming',
  mock: 'mock_voice',
}

const DEFAULT_SPEED: Record<Register, number> = {
  peer: 1.05,
  storyteller: 1.0,
  concise: 1.0,
}

const ENV_BY_REGISTER: Record<Register, string> = {
  peer: 'TTS_VOICE_PEER',
  storyteller: 'TTS_VOICE_CHILD',
  concise: 'TTS_VOICE_LIGHT',
}

export const placeholderVoice = (provider: string): string =>
  PLACEHOLDER_VOICE[provider] ?? PLACEHOLDER_VOICE.mock ?? 'mock_voice'

export const resolveVoice = (
  register: Register,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig => {
  const configured = env[ENV_BY_REGISTER[register]]
  const speed = env[`${ENV_BY_REGISTER[register]}_SPEED`]
  return {
    voice: configured === undefined || configured === ''
      ? placeholderVoice(provider)
      : configured,
    speedRatio: speed === undefined || speed === ''
      ? DEFAULT_SPEED[register]
      : Number(speed),
  }
}

export const voiceEnvName = (register: Register): string => ENV_BY_REGISTER[register]

export const usingPlaceholderVoice = (
  register: Register, provider: string, env: NodeJS.ProcessEnv = process.env,
): boolean => resolveVoice(register, provider, env).voice === placeholderVoice(provider)
