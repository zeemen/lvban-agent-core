import { afterAll, describe, expect, test } from 'vitest'
import { getProfile, updateProfile } from '../../src/memory/profile.js'
import { createUser, teardown } from '../helpers/db.js'

/** PRD U02：3 分钟建档，3 个问题，可跳过则用默认档 */

afterAll(async () => { await teardown() })

describe('读取档案', () => {
  test('新用户拿到默认档，而不是空对象', async () => {
    const profile = await getProfile(await createUser())

    expect(profile?.defaultMode).toBe('companion')
    expect(profile?.voicePref).toBe('voice')
  })

  test('别人的档案读不到', async () => {
    await createUser()
    expect(await getProfile('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('建档', () => {
  test('三个问题一次写入', async () => {
    const userId = await createUser()

    await updateProfile(userId, {
      ageBand: '16_18', defaultMode: 'light_guide', voicePref: 'text',
    })

    const profile = await getProfile(userId)
    expect(profile?.ageBand).toBe('16_18')
    expect(profile?.defaultMode).toBe('light_guide')
    expect(profile?.voicePref).toBe('text')
  })

  test('只答其中一个，其余保持原样（可跳过）', async () => {
    const userId = await createUser({ ageBand: '19_24' })

    await updateProfile(userId, { voicePref: 'text' })

    const profile = await getProfile(userId)
    expect(profile?.ageBand).toBe('19_24')
    expect(profile?.voicePref).toBe('text')
  })

  test('年龄段决定未成年标记——这关系到后续的保护策略', async () => {
    const userId = await createUser({ ageBand: '25_plus' })

    await updateProfile(userId, { ageBand: '12_15' })

    expect((await getProfile(userId))?.isMinor).toBe(true)
  })

  test('成年段不会被标成未成年', async () => {
    const userId = await createUser()

    await updateProfile(userId, { ageBand: '25_plus' })

    expect((await getProfile(userId))?.isMinor).toBe(false)
  })

  test('改不动别人的档案', async () => {
    const owner = await createUser({ ageBand: '19_24' })

    const updated = await updateProfile(
      '00000000-0000-0000-0000-000000000000', { ageBand: '12_15' },
    )

    expect(updated).toBe(false)
    expect((await getProfile(owner))?.ageBand).toBe('19_24')
  })
})

/**
 * 「建过档了吗」不能靠看值猜：三问都有数据库默认值，
 * 选了 companion 和从没打开过建档页在库里长得一样。
 * 行前提示要不要出现全看这一位，判错了不是漏提醒就是反复骚扰。
 */
describe('建过档了吗', () => {
  test('新用户没建过档', async () => {
    expect((await getProfile(await createUser()))?.profileCompleted).toBe(false)
  })

  test('答了一问就算建过——不要求三问答全', async () => {
    const userId = await createUser()

    await updateProfile(userId, { voicePref: 'text' })

    expect((await getProfile(userId))?.profileCompleted).toBe(true)
  })

  test('答的恰好是默认值也算建过，这正是单看值分不出来的情况', async () => {
    const userId = await createUser()

    await updateProfile(userId, { defaultMode: 'companion' })

    expect((await getProfile(userId))?.profileCompleted).toBe(true)
  })

  test('只改昵称不算建档——昵称不是建档问的三个问题之一', async () => {
    const userId = await createUser()

    await updateProfile(userId, { nickname: '阿要' })

    expect((await getProfile(userId))?.profileCompleted).toBe(false)
  })
})
