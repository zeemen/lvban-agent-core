import { ttsProvider } from './router.js'

/**
 * TTS 现在可用吗。
 *
 * 和视觉链路同一个思路（规格 02 §4.3）：配置根本不可能成功的情况要提前判定，
 * 让产品降级到「只显示文字」，而不是在用户等着听声音的时候抛错。
 */

export type TtsVerdict =
  | { readonly available: true; readonly provider: string }
  | { readonly available: false; readonly reason: string }

export const ttsAvailability = (env: NodeJS.ProcessEnv = process.env): TtsVerdict => {
  const provider = ttsProvider(env)
  if (provider === 'mock') return { available: true, provider }

  if (provider === 'tencent') {
    const id = (env.TENCENT_SECRET_ID ?? '').trim()
    const key = (env.TENCENT_SECRET_KEY ?? '').trim()
    if (id === '' || key === '') {
      return {
        available: false,
        reason: '腾讯云 TTS 未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY',
      }
    }
    return { available: true, provider }
  }

  if (provider === 'volcengine') {
    const appId = (env.VOLC_TTS_APP_ID ?? '').trim()
    const token = (env.VOLC_TTS_ACCESS_TOKEN ?? '').trim()
    if (appId === '' || token === '') {
      return {
        available: false,
        reason: '火山引擎 TTS 未配置 VOLC_TTS_APP_ID / VOLC_TTS_ACCESS_TOKEN',
      }
    }
    return { available: true, provider }
  }

  return { available: false, reason: `未知的 TTS 供应商：${provider}` }
}
