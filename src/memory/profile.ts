import { pool } from '../db/pool.js'
import type { AgeBand, Mode } from '../domain/enums.js'

/**
 * 用户档案（PRD U02：3 分钟建档，3 个问题，可跳过）。
 *
 * 三个问题分别落在：age_band（决定人设与未成年保护）、
 * default_mode（三副面孔）、explain_pref.voice（语音还是文字）。
 *
 * is_minor 是数据库生成列，不在这里算——年龄段与未成年判定必须只有一处定义，
 * 否则哪天改了档位划分就会出现两套口径。
 *
 * profileCompleted 回答的是「这个人答过建档吗」，不是「档案里有值吗」：
 * 三问都有数据库默认值，光看值分不出「选了默认的那一项」和「从没打开过建档页」。
 */

export type VoicePref = 'voice' | 'text'

export type Profile = {
  readonly userId: string
  readonly nickname: string | null
  readonly ageBand: AgeBand
  readonly defaultMode: Mode
  readonly voicePref: VoicePref
  readonly isMinor: boolean
  /** 三问里答过任意一问。昵称不算——它不是建档问的 */
  readonly profileCompleted: boolean
}

type Row = {
  id: string; nickname: string | null; age_band: AgeBand
  default_mode: Mode; explain_pref: unknown; is_minor: boolean
  profile_updated_at: Date | null
}

const voicePrefOf = (explainPref: unknown): VoicePref => {
  if (typeof explainPref !== 'object' || explainPref === null) return 'voice'
  const { voice } = explainPref as { voice?: unknown }
  return voice === 'text' ? 'text' : 'voice'
}

const toProfile = (row: Row): Profile => ({
  userId: row.id,
  nickname: row.nickname,
  ageBand: row.age_band,
  defaultMode: row.default_mode,
  voicePref: voicePrefOf(row.explain_pref),
  isMinor: row.is_minor,
  profileCompleted: row.profile_updated_at !== null,
})

export const getProfile = async (userId: string): Promise<Profile | null> => {
  const { rows } = await pool.query<Row>(
    `SELECT id, nickname, age_band, default_mode, explain_pref, is_minor, profile_updated_at
       FROM app_user WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  )
  const row = rows[0]
  return row === undefined ? null : toProfile(row)
}

export type ProfilePatch = {
  readonly nickname?: string
  readonly ageBand?: AgeBand
  readonly defaultMode?: Mode
  readonly voicePref?: VoicePref
}

/** 没答的问题保持原样：建档允许跳过，不能把未作答当成「选了默认值」覆盖掉既有档案 */
export const updateProfile = async (
  userId: string, patch: ProfilePatch,
): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `UPDATE app_user SET
       nickname     = COALESCE($2, nickname),
       age_band     = COALESCE($3, age_band),
       default_mode = COALESCE($4, default_mode),
       explain_pref = CASE WHEN $5::text IS NULL THEN explain_pref
                           ELSE explain_pref || jsonb_build_object('voice', $5::text) END,
       -- 只有三问之一真的答了才算建过档；单改昵称不算
       profile_updated_at = CASE
         WHEN $3::text IS NOT NULL OR $4::text IS NOT NULL OR $5::text IS NOT NULL
         THEN now() ELSE profile_updated_at END
     WHERE id = $1 AND deleted_at IS NULL`,
    [userId, patch.nickname ?? null, patch.ageBand ?? null,
      patch.defaultMode ?? null, patch.voicePref ?? null],
  )
  return (rowCount ?? 0) > 0
}
