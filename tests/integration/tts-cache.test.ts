import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CACHE_DIR, cachePath, cacheKey, cachedSize, namedPath, readCached, writeCached,
} from '../../src/tts/cache.js'
import { pickTtsAdapter, resetTtsAdapter, synthesize, ttsProvider } from '../../src/tts/router.js'

/** 音频缓存 —— 规格 03 §7.2：固定台词一次合成、永久复用 */

const VOICE = 'test_voice'

afterEach(async () => {
  vi.unstubAllEnvs()
  resetTtsAdapter()
  await rm(namedPath('__test__'), { recursive: true, force: true })
})

describe('缓存读写', () => {
  test('写进去读得出来', async () => {
    const path = namedPath('__test__/sample.mp3')

    await writeCached(path, Buffer.from('hello'))

    expect((await readCached(path))?.toString()).toBe('hello')
  })

  test('没写过时返回 null 而不是抛错', async () => {
    expect(await readCached(namedPath('__test__/missing.mp3'))).toBeNull()
    expect(await cachedSize(namedPath('__test__/missing.mp3'))).toBeNull()
  })

  test('会自动建目录', async () => {
    const path = namedPath('__test__/deep/nested/a.mp3')

    await writeCached(path, Buffer.from('x'))

    expect(await cachedSize(path)).toBe(1)
  })

  test('哈希路径落在缓存目录内', () => {
    const key = cacheKey({
      provider: 'p', voice: 'v', text: 't', encoding: 'mp3', speedRatio: 1,
    })

    expect(cachePath(key, 'mp3')).toContain(CACHE_DIR)
    expect(cachePath(key, 'mp3')).toMatch(/\.mp3$/)
  })
})

describe('synthesize 与缓存', () => {
  test('首次合成写缓存，第二次直接命中', async () => {
    const text = `缓存测试 ${Date.now()}`

    const first = await synthesize({ text, voice: VOICE })
    const second = await synthesize({ text, voice: VOICE })

    expect(first?.cached).toBe(false)
    expect(second?.cached).toBe(true)
    expect(second?.latencyMs).toBe(0)
    expect(second?.audio.equals(first?.audio ?? Buffer.alloc(0))).toBe(true)
  })

  test('cacheOnly 未命中时返回 null，不发起合成', async () => {
    const result = await synthesize(
      { text: `从未合成过 ${Date.now()}`, voice: VOICE }, { cacheOnly: true },
    )

    expect(result).toBeNull()
  })

  test('cacheOnly 命中时正常返回', async () => {
    const text = `先合成再只读 ${Date.now()}`
    await synthesize({ text, voice: VOICE })

    const result = await synthesize({ text, voice: VOICE }, { cacheOnly: true })

    expect(result?.cached).toBe(true)
  })

  test('namedKey 用作者指定的稳定路径，不用哈希', async () => {
    const result = await synthesize(
      { text: '固定台词', voice: VOICE }, { namedKey: '__test__/named.mp3' },
    )

    expect(result?.path).toBe(namedPath('__test__/named.mp3'))
  })

  test('换音色会产生不同的缓存条目', async () => {
    const text = `同文本不同音色 ${Date.now()}`

    const a = await synthesize({ text, voice: 'voice_a' })
    const b = await synthesize({ text, voice: 'voice_b' })

    expect(a?.path).not.toBe(b?.path)
  })
})

describe('供应商选择', () => {
  test('默认是 mock，保证离线可开发', () => {
    expect(ttsProvider({})).toBe('mock')
    expect(pickTtsAdapter({}).name).toBe('mock')
  })

  test('未知供应商直接报错并列出可选项', () => {
    expect(() => pickTtsAdapter({ TTS_PROVIDER: 'nope' }))
      .toThrow(/mock \/ tencent \/ volcengine/)
  })

  test('选腾讯但缺密钥时在创建适配器处就报错', () => {
    expect(() => pickTtsAdapter({ TTS_PROVIDER: 'tencent' }))
      .toThrow(/TENCENT_SECRET_ID/)
  })

  test('选火山但缺凭据时在创建适配器处就报错', () => {
    expect(() => pickTtsAdapter({ TTS_PROVIDER: 'volcengine' }))
      .toThrow(/VOLC_TTS_APP_ID/)
  })
})
