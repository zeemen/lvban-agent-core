import { afterAll, describe, expect, test } from 'vitest'
import { uuidv7 } from 'uuidv7'
import {
  deleteAllMemory, deleteMemory, exportMemory, getMemoryWhy, patchMemory,
} from '../../src/memory/rights.js'
import * as repo from '../../src/memory/repo.js'
import { createUser, pool, teardown } from '../helpers/db.js'

/** 规格 01 §7：Memory-visible · Editable · Deletable · Exportable */

afterAll(async () => { await teardown() })

const seedPreference = async (userId: string, value: string, journeyIds: string[]) =>
  repo.upsertPreference({
    userId, dimension: 'topic_interest', value, strength: 0.7,
    status: 'active', source: 'explicit',
    evidence: journeyIds.map((journeyId) => ({
      journeyId, party: 'solo', at: '2026-10-01T00:00:00Z', quote: `我想看${value}`,
    })),
    journeyCount: journeyIds.length, seenAt: new Date(),
  })

const seedTrait = async (userId: string, trait: string, journeyIds: string[]) => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO identity_trait
       (id, user_id, trait, status, supporting_journeys, party_invariant, promoted_at, explanation)
     VALUES ($1,$2,$3,'active',$4,true,now(),$5) RETURNING id`,
    [uuidv7(), userId, trait, journeyIds, `因为你问过 ${journeyIds.length} 次`],
  )
  return rows[0]!.id
}

describe('为什么会记住这条', () => {
  test('偏好能给出证据链：哪几次旅程、说过什么', async () => {
    const userId = await createUser()
    const id = await seedPreference(userId, '青铜器', [uuidv7(), uuidv7()])

    const why = await getMemoryWhy(userId, id)

    expect(why?.kind).toBe('preference')
    expect(why?.evidence).toHaveLength(2)
    expect(why?.evidence[0]?.quote).toContain('青铜器')
  })

  test('身份层给出晋升路径，说明凭哪几次旅程升上来的', async () => {
    const userId = await createUser()
    const journeys = [uuidv7(), uuidv7(), uuidv7()]
    const id = await seedTrait(userId, '青铜器爱好者', journeys)

    const why = await getMemoryWhy(userId, id)

    expect(why?.kind).toBe('identity')
    expect(why?.promotion).toContain('3')
    expect(why?.evidence).toHaveLength(3)
  })

  test('读不到别人的记忆——数据层也挡一道，不只靠路由', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const id = await seedPreference(owner, '瓷器', [uuidv7()])

    expect(await getMemoryWhy(stranger, id)).toBeNull()
  })

  test('不存在的 id 返回 null', async () => {
    expect(await getMemoryWhy(await createUser(), uuidv7())).toBeNull()
  })
})

describe('修改', () => {
  test('能改偏好的值', async () => {
    const userId = await createUser()
    const id = await seedPreference(userId, '青铜器', [uuidv7()])

    const result = await patchMemory(userId, id, { value: '玉器' })

    expect(result.updated).toBe(true)
    const prefs = await repo.listPreferences(userId)
    expect(prefs.find((p) => p.id === id)?.value).toBe('玉器')
  })

  test('标记「这不对」后这条不再出现在记忆列表里', async () => {
    const userId = await createUser()
    const id = await seedPreference(userId, '青铜器', [uuidv7()])

    await patchMemory(userId, id, { status: 'user_removed' })

    const prefs = await repo.listPreferences(userId)
    expect(prefs.find((p) => p.id === id)).toBeUndefined()
  })

  test('改不动别人的记忆', async () => {
    const owner = await createUser()
    const id = await seedPreference(owner, '青铜器', [uuidv7()])

    const result = await patchMemory(await createUser(), id, { value: '玉器' })

    expect(result.updated).toBe(false)
  })
})

describe('标记「这不对」之后不能被蒸馏复活', () => {
  test('再次蒸馏写入同一条偏好时，user_removed 必须保留', async () => {
    const userId = await createUser()
    const journeyId = uuidv7()
    const id = await seedPreference(userId, '青铜器', [journeyId])
    await patchMemory(userId, id, { status: 'user_removed' })

    // 模拟后续旅程再次蒸馏出同一个偏好
    await seedPreference(userId, '青铜器', [journeyId, uuidv7()])

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM preference WHERE id = $1', [id],
    )
    expect(rows[0]?.status).toBe('user_removed')
  })
})

describe('删除与级联', () => {
  test('删掉偏好后，依赖它的身份特征跟着降级（规格 01 §7.1）', async () => {
    const userId = await createUser()
    const journeys = [uuidv7(), uuidv7(), uuidv7()]
    const prefId = await seedPreference(userId, '青铜器', journeys)
    await seedTrait(userId, '青铜器爱好者', journeys)

    await deleteMemory(userId, prefId)

    const traits = await repo.listIdentityTraits(userId)
    expect(traits.find((t) => t.trait === '青铜器爱好者')).toBeUndefined()
  })

  test('只删掉其中一个偏好时，不相关的身份特征不受影响', async () => {
    const userId = await createUser()
    const a = [uuidv7(), uuidv7(), uuidv7()]
    const b = [uuidv7(), uuidv7(), uuidv7()]
    const prefA = await seedPreference(userId, '青铜器', a)
    await seedPreference(userId, '书法', b)
    await seedTrait(userId, '青铜器爱好者', a)
    await seedTrait(userId, '书法爱好者', b)

    await deleteMemory(userId, prefA)

    const traits = await repo.listIdentityTraits(userId)
    expect(traits.map((t) => t.trait)).toEqual(['书法爱好者'])
  })

  test('直接删身份特征也生效', async () => {
    const userId = await createUser()
    const id = await seedTrait(userId, '瓷器爱好者', [uuidv7()])

    await deleteMemory(userId, id)

    expect(await repo.listIdentityTraits(userId)).toHaveLength(0)
  })

  test('删不动别人的记忆', async () => {
    const owner = await createUser()
    const id = await seedPreference(owner, '青铜器', [uuidv7()])

    expect((await deleteMemory(await createUser(), id)).deleted).toBe(false)
    expect(await repo.listPreferences(owner)).toHaveLength(1)
  })

  test('删除会留审计记录', async () => {
    const userId = await createUser()
    const id = await seedPreference(userId, '青铜器', [uuidv7()])

    await deleteMemory(userId, id)

    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM memory_audit
        WHERE user_id = $1 AND action = 'delete'`, [userId],
    )
    expect(Number(rows[0]?.n)).toBeGreaterThan(0)
  })
})

describe('导出', () => {
  test('导出包含身份、偏好与足迹，且每条偏好带证据', async () => {
    const userId = await createUser()
    await seedPreference(userId, '青铜器', [uuidv7(), uuidv7()])
    await seedTrait(userId, '青铜器爱好者', [uuidv7(), uuidv7(), uuidv7()])

    const bundle = await exportMemory(userId)

    expect(bundle.preferences).toHaveLength(1)
    expect(bundle.preferences[0]?.evidence).toHaveLength(2)
    expect(bundle.identity).toHaveLength(1)
    expect(bundle.exportedAt).toMatch(/^\d{4}-/)
  })

  test('导出里不含别人的数据', async () => {
    const me = await createUser()
    const other = await createUser()
    await seedPreference(other, '别人的偏好', [uuidv7()])

    const bundle = await exportMemory(me)

    expect(JSON.stringify(bundle)).not.toContain('别人的偏好')
  })

  test('导出留审计记录', async () => {
    const userId = await createUser()
    await exportMemory(userId)

    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM memory_audit
        WHERE user_id = $1 AND action = 'export'`, [userId],
    )
    expect(Number(rows[0]?.n)).toBe(1)
  })
})

describe('清空全部记忆', () => {
  test('偏好、身份、足迹都清掉，账户保留', async () => {
    const userId = await createUser()
    await seedPreference(userId, '青铜器', [uuidv7()])
    await seedTrait(userId, '青铜器爱好者', [uuidv7()])

    const result = await deleteAllMemory(userId)

    expect(result.preferences).toBe(1)
    expect(result.traits).toBe(1)
    expect(await repo.listPreferences(userId)).toHaveLength(0)
    expect(await repo.listIdentityTraits(userId)).toHaveLength(0)
    const { rows } = await pool.query('SELECT id FROM app_user WHERE id = $1', [userId])
    expect(rows).toHaveLength(1)
  })

  test('不会清掉别人的', async () => {
    const me = await createUser()
    const other = await createUser()
    await seedPreference(other, '青铜器', [uuidv7()])

    await deleteAllMemory(me)

    expect(await repo.listPreferences(other)).toHaveLength(1)
  })
})
