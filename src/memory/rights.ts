import { pool } from '../db/pool.js'
import * as repo from './repo.js'
import { distillation as cfg } from '../config/index.js'

/**
 * 用户权利接口的数据层（规格 01 §7）：
 * Memory-visible · Editable · Deletable · Exportable。
 *
 * 每条查询都带 user_id 条件，而不是先查出来再比对。
 * 路由层已经校验过身份，这里再挡一道：越权读写在 SQL 层就不成立，
 * 将来多一个调用方也不会漏掉检查。
 */

export type MemoryKind = 'preference' | 'identity'

export type EvidenceItem = {
  readonly journeyId: string
  readonly party?: string
  readonly at?: string
  readonly quote?: string
}

export type MemoryWhy = {
  readonly id: string
  readonly kind: MemoryKind
  readonly label: string
  readonly evidence: readonly EvidenceItem[]
  /** 晋升路径：这条为什么会从下一层升上来 */
  readonly promotion: string
}

const asEvidence = (raw: unknown): readonly EvidenceItem[] =>
  Array.isArray(raw) ? (raw as EvidenceItem[]) : []

export const getMemoryWhy = async (
  userId: string, memoryId: string,
): Promise<MemoryWhy | null> => {
  const { rows: prefs } = await pool.query<{
    id: string; value: string; dimension: string
    evidence_refs: unknown; journey_count: number; strength: string; source: string
  }>(
    `SELECT id, value, dimension, evidence_refs, journey_count, strength, source
       FROM preference WHERE id = $1 AND user_id = $2`,
    [memoryId, userId],
  )
  const pref = prefs[0]
  if (pref !== undefined) {
    const evidence = asEvidence(pref.evidence_refs)
    return {
      id: pref.id,
      kind: 'preference',
      label: pref.value,
      evidence,
      promotion: `你在 ${pref.journey_count} 次旅程里提到过「${pref.value}」，`
        + `来源是${pref.source === 'explicit' ? '你自己说的' : '你确认过的'}，`
        + `当前强度 ${pref.strength}。`
        + `连续 ${cfg.d3JourneyCountMin} 次以上才会升为身份层。`,
    }
  }

  const { rows: traits } = await pool.query<{
    id: string; trait: string; explanation: string
    supporting_journeys: string[]; party_invariant: boolean; status: string
  }>(
    `SELECT id, trait, explanation, supporting_journeys, party_invariant, status
       FROM identity_trait WHERE id = $1 AND user_id = $2`,
    [memoryId, userId],
  )
  const trait = traits[0]
  if (trait === undefined) return null

  return {
    id: trait.id,
    kind: 'identity',
    label: trait.trait,
    evidence: trait.supporting_journeys.map((journeyId) => ({ journeyId })),
    promotion: `${trait.explanation}（${trait.supporting_journeys.length} 次旅程支持，`
      + `${trait.party_invariant ? '不同同行人情形下都成立' : '仅在同一种同行人情形下出现'}，`
      + `状态 ${trait.status}）。`,
  }
}

export type MemoryPatch = {
  readonly value?: string
  readonly strength?: number
  /** 'user_removed' 即「这不对」。标记后蒸馏不得复活 */
  readonly status?: 'user_removed'
}

export const patchMemory = async (
  userId: string, memoryId: string, patch: MemoryPatch,
): Promise<{ updated: boolean; kind: MemoryKind | null }> => {
  if (patch.status === 'user_removed') {
    const result = await deleteMemory(userId, memoryId)
    return { updated: result.deleted, kind: result.kind }
  }

  const { rowCount } = await pool.query(
    `UPDATE preference
        SET value    = COALESCE($3, value),
            strength = COALESCE($4, strength),
            source   = 'user_confirmed'
      WHERE id = $1 AND user_id = $2`,
    [memoryId, userId, patch.value ?? null, patch.strength ?? null],
  )
  if ((rowCount ?? 0) > 0) {
    await repo.audit({
      userId, action: 'write', layer: 'L2', targetId: memoryId,
      reason: '用户手动修改', actor: 'user',
    })
    return { updated: true, kind: 'preference' }
  }
  return { updated: false, kind: null }
}

/**
 * 级联：删掉一条偏好后，由它支撑的身份特征必须跟着重算。
 * 规格 01 §7.1 ——「删了却还记得」会直接击穿信任。
 *
 * 身份特征是从 topic_interest 偏好派生的（trait = `${value}爱好者`），
 * 所以底下的偏好没了，这条特征就失去依据，直接移除；
 * 还在但支撑旅程数不够，降回 candidate。
 */
export const reconcileIdentityTraits = async (userId: string): Promise<number> => {
  const prefs = await repo.listPreferences(userId)
  const activeValues = new Set(
    prefs.filter((p) => p.status === 'active' && p.dimension === 'topic_interest')
      .map((p) => p.value),
  )

  const { rows } = await pool.query<{
    id: string; trait: string; supporting_journeys: string[]
  }>(
    `SELECT id, trait, supporting_journeys FROM identity_trait
      WHERE user_id = $1 AND status <> 'user_removed'`,
    [userId],
  )

  let changed = 0
  for (const row of rows) {
    const derivedFrom = row.trait.replace(/爱好者$/, '')
    if (!activeValues.has(derivedFrom)) {
      await pool.query('DELETE FROM identity_trait WHERE id = $1', [row.id])
      await repo.audit({
        userId, action: 'delete', layer: 'L3', targetId: row.id,
        reason: `支撑它的偏好「${derivedFrom}」已被删除`, actor: 'system:reconcile',
      })
      changed += 1
      continue
    }
    if (row.supporting_journeys.length < cfg.d3JourneyCountMin) {
      await pool.query(
        `UPDATE identity_trait SET status = 'candidate', promoted_at = NULL WHERE id = $1`,
        [row.id],
      )
      await repo.audit({
        userId, action: 'decay', layer: 'L3', targetId: row.id,
        reason: `支撑旅程数 ${row.supporting_journeys.length} 低于阈值 ${cfg.d3JourneyCountMin}`,
        actor: 'system:reconcile',
      })
      changed += 1
    }
  }
  return changed
}

export const deleteMemory = async (
  userId: string, memoryId: string,
): Promise<{ deleted: boolean; kind: MemoryKind | null; traitsReconciled: number }> => {
  // 偏好用软删除：标成 user_removed，蒸馏据此不再复活它
  const { rowCount: prefRows } = await pool.query(
    `UPDATE preference SET status = 'user_removed' WHERE id = $1 AND user_id = $2`,
    [memoryId, userId],
  )
  if ((prefRows ?? 0) > 0) {
    await repo.audit({
      userId, action: 'delete', layer: 'L2', targetId: memoryId,
      reason: '用户删除', actor: 'user',
    })
    const traitsReconciled = await reconcileIdentityTraits(userId)
    return { deleted: true, kind: 'preference', traitsReconciled }
  }

  const { rowCount: traitRows } = await pool.query(
    `UPDATE identity_trait SET status = 'user_removed', promoted_at = NULL
      WHERE id = $1 AND user_id = $2`,
    [memoryId, userId],
  )
  if ((traitRows ?? 0) > 0) {
    await repo.audit({
      userId, action: 'delete', layer: 'L3', targetId: memoryId,
      reason: '用户删除', actor: 'user',
    })
    return { deleted: true, kind: 'identity', traitsReconciled: 0 }
  }

  return { deleted: false, kind: null, traitsReconciled: 0 }
}

export type ExportBundle = {
  readonly exportedAt: string
  readonly identity: readonly { trait: string; explanation: string; status: string }[]
  readonly preferences: readonly {
    id: string; dimension: string; value: string
    strength: number; journeyCount: number; evidence: readonly EvidenceItem[]
  }[]
  readonly footprints: readonly unknown[]
}

/** PIPL 第 45 条的可携带权：结构化、可读、只含本人数据 */
export const exportMemory = async (userId: string): Promise<ExportBundle> => {
  const [identity, preferences, footprints] = await Promise.all([
    repo.listIdentityTraits(userId),
    repo.listPreferences(userId),
    repo.listFootprints(userId, 500),
  ])
  await repo.audit({ userId, action: 'export', reason: '用户导出全部记忆', actor: 'user' })
  return {
    exportedAt: new Date().toISOString(),
    identity,
    preferences: preferences.map((p) => ({
      id: p.id, dimension: p.dimension, value: p.value,
      strength: Number(p.strength), journeyCount: p.journey_count,
      evidence: asEvidence(p.evidence_refs),
    })),
    footprints,
  }
}

/** 清空记忆但保留账户（规格 01 §7）。足迹是硬删除：它没有「用户删除」这个状态 */
export const deleteAllMemory = async (userId: string): Promise<{
  preferences: number; traits: number; footprints: number
}> => {
  const prefs = await pool.query(
    `UPDATE preference SET status = 'user_removed'
      WHERE user_id = $1 AND status <> 'user_removed'`, [userId],
  )
  const traits = await pool.query(
    `UPDATE identity_trait SET status = 'user_removed', promoted_at = NULL
      WHERE user_id = $1 AND status <> 'user_removed'`, [userId],
  )
  const footprints = await pool.query(
    'DELETE FROM semantic_footprint WHERE user_id = $1', [userId],
  )
  await repo.audit({
    userId, action: 'delete', layer: 'all',
    reason: '用户清空全部记忆（账户保留）', actor: 'user',
  })
  return {
    preferences: prefs.rowCount ?? 0,
    traits: traits.rowCount ?? 0,
    footprints: footprints.rowCount ?? 0,
  }
}
