import { uuidv7 } from 'uuidv7'
import { closePool, pool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import { loadAnchors, loadGeofences } from './loader.js'

/** 开发期种子数据：一个 demo 用户 + 校验内容文件可被解析 */

const DEMO_OPENID = 'demo_openid_companion'

const run = async (): Promise<void> => {
  const anchors = await loadAnchors()
  const fences = await loadGeofences()
  console.log(`[seed] 锚点 ${anchors.size} 个，围栏 ${fences.length} 个`)

  for (const anchor of anchors.values()) {
    if (anchor.review.status !== 'approved') {
      console.warn(
        `[seed] 锚点 ${anchor.anchorId} 审校状态=${anchor.review.status}，` +
        `待核项 ${anchor.review.factCheckRequired.length} 条（规格 03 §9.2 要求 Top30 上线前双签）`,
      )
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, wx_openid, nickname, age_band, default_mode)
     VALUES ($1, $2, '演示用户·大二', '19_24', 'companion')
     ON CONFLICT (wx_openid) DO UPDATE SET nickname = EXCLUDED.nickname
     RETURNING id`,
    [uuidv7(), DEMO_OPENID],
  )
  console.log(`[seed] demo user = ${rows[0]?.id}`)
}

run()
  .then(async () => { await closePool(); await closeRedis() })
  .catch(async (error: unknown) => {
    console.error(error)
    await closePool(); await closeRedis()
    process.exit(1)
  })
