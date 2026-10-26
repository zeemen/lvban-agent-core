import { location as cfg } from '../config/index.js'
import { loadGeofences } from '../content/loader.js'
import { writeMemory } from '../memory/gateway.js'
import * as repo from '../memory/repo.js'
import {
  evaluateGeofence, pickActiveFence, type Fix, type GeofenceDef,
} from './geofence.js'
import { readTracker, writeTracker } from './tracker.js'

/**
 * 采集上报处理 —— 规格 02 §8.1。
 *
 * 服务端不信任客户端：精度过滤、授权校验都在这里再做一遍
 * （track_consent 的二次校验在 Memory Write Gateway 里）。
 */

let fenceCache: readonly GeofenceDef[] | null = null

const fences = async (sceneId: string): Promise<readonly GeofenceDef[]> => {
  fenceCache ??= await loadGeofences()
  return fenceCache.filter((f) => f.sceneId === sceneId)
}

export type IngestResult = {
  readonly accepted: number
  readonly dropped: number
  readonly dropReasons: readonly string[]
  readonly events: readonly { readonly poiId: string; readonly kind: 'arrive' | 'leave' }[]
  readonly blocked: readonly { readonly poiId: string; readonly blockedBy: string }[]
}

export const ingestFixes = async (input: {
  readonly journeyId: string
  readonly fixes: readonly Fix[]
}): Promise<IngestResult> => {
  const journey = await repo.findJourney(input.journeyId)
  if (journey === null) throw new Error(`旅程不存在：${input.journeyId}`)

  const defs = await fences(journey.scene_id)
  const events: { poiId: string; kind: 'arrive' | 'leave' }[] = []
  const blocked: { poiId: string; blockedBy: string }[] = []
  const dropReasons: string[] = []
  let accepted = 0
  let dropped = 0

  for (const fix of input.fixes) {
    // 规格 02 §2.2：精度过滤
    if (fix.accuracyM > cfg.maxAccuracyM) {
      dropped += 1
      dropReasons.push('accuracy_too_low')
      continue
    }
    accepted += 1

    const active = pickActiveFence(defs, fix)
    const relevant = active === null ? defs : [active]

    for (const def of relevant) {
      const prior = await readTracker(input.journeyId, def.poiId)
      const result = evaluateGeofence(def, prior, fix)
      if (result.state !== prior) {
        await writeTracker(input.journeyId, def.poiId, result.state)
      }
      if (result.event !== null) {
        events.push({ poiId: def.poiId, kind: result.event })
        await writeMemory({
          kind: 'location_event',
          userId: journey.user_id,
          journeyId: input.journeyId,
          eventKind: result.event,
          poiId: def.poiId,
          source: 'geofence',
          dwellSec: result.event === 'arrive' ? (def.minDwellSec ?? cfg.geofenceMinDwellSec) : null,
          occurredAt: fix.at,
        })
      } else if (result.blockedBy !== null && result.blockedBy !== 'outside') {
        blocked.push({ poiId: def.poiId, blockedBy: result.blockedBy })
      }
    }
  }

  // 原始轨迹：网关按 track_consent 决定是否真的写（非 full_track 直接拒）
  if (input.fixes.length > 0) {
    await writeMemory({
      kind: 'raw_track',
      userId: journey.user_id,
      journeyId: input.journeyId,
      points: input.fixes.map((f) => ({
        lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, recordedAt: f.at,
      })),
    })
  }

  return { accepted, dropped, dropReasons, events, blocked }
}
