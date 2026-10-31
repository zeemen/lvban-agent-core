import type { ContextState } from '../domain/context-state.js'

/**
 * 位置来源与置信度 —— 规格 02 §30「室内不伪造精确位置」。
 *
 * 室外的 poiId 是围栏引擎算出来的，说 geofence 名副其实。室内不是：
 * content/geofences/ 里没有也不该有 nanjing_museum，室内一个围栏都没有，
 * 所以室内的 poiId 只能来自规格 02 §4.1 的四件套——用户选展区、视觉识别、
 * 展品编号、已访问点位推断——围栏不在其中。
 *
 * 分开定这件事的理由：置信度不是装饰，规格 02 §7.2 拿 0.6 当硬否决线
 * （「不确定在哪，就别装作知道」）。室内默认给 0.9 等于让这条线永远不生效。
 */

export type LocationScene = 'indoor' | 'outdoor'
export type LocationSource = ContextState['locationSource']
export type Provenance = { readonly source: LocationSource; readonly confidence: number }
/** 客户端能自报的来源。none 不在其中：手里有 poiId 就不叫「没有位置」 */
export type DeclaredSource = Exclude<LocationSource, 'none'>

/** §4.1 ①：用户自己选的展区就是 1.0 */
const USER_CONFIRMED = 1
/** §4.1 ④：已访问点位推断 ≤ 0.6，且「不单独成立」 */
const INFERRED_CEILING = 0.6
/** 压在 §7.2 的 0.6 否决线以下，让「不单独成立」真的拦得住主动开口 */
const INFERRED_DEFAULT = 0.5
/** 室外 poiId 由围栏引擎给出 */
const GEOFENCE = 0.9

/** 室内合法来源（§4.1 四件套，展品编号归入 user_confirmed 的精确匹配） */
const INDOOR_SOURCES: readonly LocationSource[] = ['user_confirmed', 'vision_anchor', 'inferred']

const inferred = (declared?: number): Provenance => ({
  source: 'inferred',
  confidence: Math.min(declared ?? INFERRED_DEFAULT, INFERRED_CEILING),
})

const forSource = (source: LocationSource, declared?: number): Provenance => {
  switch (source) {
    case 'none':
      return { source: 'none', confidence: 0 }
    case 'user_confirmed':
      // 用户点的就是用户点的，客户端报多少都不作数
      return { source, confidence: USER_CONFIRMED }
    case 'vision_anchor':
      // 分数是 VLM 的 top-1，没带分数就等于没认出来
      return declared === undefined ? inferred() : { source, confidence: declared }
    case 'geofence':
      return { source, confidence: declared ?? GEOFENCE }
    case 'inferred':
      return inferred(declared)
  }
}

export const resolveLocationProvenance = (input: {
  readonly poiId: string | null
  readonly scene: LocationScene
  readonly declaredSource?: LocationSource
  readonly declaredConfidence?: number
}): Provenance => {
  if (input.poiId === null) return { source: 'none', confidence: 0 }

  if (input.scene === 'indoor') {
    const declared = input.declaredSource
    // 室内声明成 geofence 的一律不认，连它报的置信度也不信
    if (declared === undefined || !INDOOR_SOURCES.includes(declared)) return inferred()
    return forSource(declared, input.declaredConfidence)
  }

  return forSource(input.declaredSource ?? 'geofence', input.declaredConfidence)
}
