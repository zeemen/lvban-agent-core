import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { streamQuestion, type StreamedEvent } from '../../src/agent/respond-stream.js'
import { ingestFixes } from '../../src/context/ingest.js'
import { startJourney } from '../../src/context/journey.js'
import { createMockAdapter } from '../../src/models/mock.js'
import { registerAdapter } from '../../src/models/router.js'
import type { ModelAdapter } from '../../src/models/types.js'
import { resetTtsAdapter } from '../../src/tts/router.js'
import { countRows, createUser, teardown } from '../helpers/db.js'

/**
 * 流式应答编排 —— 规格 03 §7。
 * 事件顺序就是用户体感：垫音必须在任何网络调用之前发出。
 */

afterAll(async () => {
  registerAdapter(createMockAdapter())
  await teardown()
})

const GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const POI = 'fzm_jiangnan_gongyuan'

const openJourney = async (userId: string) => {
  const journey = await startJourney({
    userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  const t0 = new Date()
  await ingestFixes({
    journeyId: journey.id,
    fixes: [
      { ...GONGYUAN, accuracyM: 12, at: t0, speedMps: 0.4 },
      { ...GONGYUAN, accuracyM: 14, at: new Date(t0.getTime() + 25_000), speedMps: 0.3 },
    ],
  })
  return journey
}

/** 按脚本逐块吐出的适配器，用来控制分句时机 */
const chunkedAdapter = (chunks: readonly string[], delayMs = 0): ModelAdapter => ({
  name: 'mock',
  async complete() {
    return {
      text: chunks.join(''), provider: 'mock', task: 'qa' as const, latencyMs: 1,
      tokensIn: 5, tokensOut: 10, reasoningTokens: 0, costCny: 0, cached: false,
    }
  },
  async *stream() {
    // 先吐一段思维链，验证它不会漏给用户
    yield { type: 'reasoning' as const, text: '内部思考，不该出现在用户侧' }
    for (const chunk of chunks) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      yield { type: 'delta' as const, text: chunk }
    }
    yield { type: 'done' as const, tokensIn: 5, tokensOut: 10, reasoningTokens: 8 }
  },
  async recognize() {
    return { candidates: [], provider: 'mock', latencyMs: 1, costCny: 0 }
  },
})

const drain = async (journeyId: string, text = '古代人怎么考试'): Promise<readonly StreamedEvent[]> => {
  const out: StreamedEvent[] = []
  for await (const event of streamQuestion({ journeyId, text, poiId: POI })) {
    out.push(event)
  }
  return out
}

describe('事件顺序', () => {
  test('垫音是第一个事件，且在模型返回任何内容之前', async () => {
    registerAdapter(chunkedAdapter(['号舍很窄，你站进去就知道了。'], 50))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)

    expect(events[0]?.type).toBe('filler')
    const firstSentence = events.findIndex((e) => e.type === 'sentence')
    expect(events.findIndex((e) => e.type === 'filler')).toBeLessThan(firstSentence)
  })

  test('垫音几乎零延迟，不等模型', async () => {
    registerAdapter(chunkedAdapter(['号舍很窄，你站进去就知道了。'], 120))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const done = events.find((e) => e.type === 'done')

    expect(done?.type).toBe('done')
    if (done?.type === 'done') {
      expect(done.timing.fillerAtMs).toBeLessThan(done.timing.firstDeltaMs ?? Infinity)
    }
  })

  test('垫音带 audioKey，前端据此播本地预合成音频', async () => {
    registerAdapter(chunkedAdapter(['一句足够长的回答在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const filler = events.find((e) => e.type === 'filler')

    expect(filler).toMatchObject({ type: 'filler' })
    if (filler?.type === 'filler') {
      expect(filler.audioKey).toMatch(/\.mp3$/)
      expect(filler.text.length).toBeLessThanOrEqual(20)
    }
  })

  test('思维链不会泄漏到用户侧的任何事件里', async () => {
    registerAdapter(chunkedAdapter(['这是给用户看的正文内容。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)

    const userFacing = JSON.stringify(
      events.filter((e) => e.type === 'delta' || e.type === 'sentence'),
    )
    expect(userFacing).not.toContain('内部思考')
  })
})

describe('分句与时序', () => {
  test('第一句在整段结束之前就能送 TTS', async () => {
    registerAdapter(chunkedAdapter(
      ['第一句话已经说完了。', '第二句还在后面慢慢来。', '第三句收尾。'], 60,
    ))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const done = events.find((e) => e.type === 'done')

    if (done?.type === 'done') {
      expect(done.timing.firstSentenceMs).not.toBeNull()
      expect(done.timing.firstSentenceMs ?? 0).toBeLessThan(done.timing.totalMs)
      expect(done.timing.sentences).toBeGreaterThanOrEqual(3)
    }
  })

  test('句子按序号递增发出', async () => {
    registerAdapter(chunkedAdapter(['第一句话在这里。', '第二句话也在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const indexes = events.filter((e) => e.type === 'sentence')
      .map((e) => (e.type === 'sentence' ? e.index : -1))

    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
  })

  test('没有终止符的结尾也会被 flush 出来', async () => {
    registerAdapter(chunkedAdapter(['这段话没有句号收尾但内容完整']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)

    expect(events.filter((e) => e.type === 'sentence').length).toBeGreaterThan(0)
  })

  test('拼起来的正文与 done 事件里的全文一致', async () => {
    const chunks = ['第一段内容在这里。', '第二段内容也在。']
    registerAdapter(chunkedAdapter(chunks))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const joined = events.filter((e) => e.type === 'delta')
      .map((e) => (e.type === 'delta' ? e.text : '')).join('')
    const done = events.find((e) => e.type === 'done')

    if (done?.type === 'done') expect(done.text).toBe(joined)
  })
})

describe('记忆写入与降级', () => {
  test('流式结束后用户与 agent 的发言都落库', async () => {
    registerAdapter(chunkedAdapter(['一句足够长的回答在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    await drain(journey.id)

    expect(await countRows(
      'interaction', `journey_id = $1 AND role = 'agent'`, [journey.id],
    )).toBe(1)
    expect(await countRows(
      'interaction', `journey_id = $1 AND role = 'user'`, [journey.id],
    )).toBe(1)
  })

  test('黑名单内容被拦下时发 error 事件并给出可说出口的话', async () => {
    registerAdapter(chunkedAdapter(['不该走到这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const out: StreamedEvent[] = []
    for await (const event of streamQuestion({
      journeyId: journey.id, text: '我有高血压还能走多久', poiId: POI,
    })) out.push(event)

    const error = out.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    if (error?.type === 'error') {
      expect(error.message).toContain('blocked_category')
      expect(error.fallbackText).not.toBe('')
    }
  })

  test('模型中途抛错时给降级话术，而不是把异常抛给调用方', async () => {
    const failing: ModelAdapter = {
      name: 'mock',
      async complete() { throw new Error('boom') },
      // eslint-disable-next-line require-yield
      async *stream() { throw new Error('上游炸了') },
      async recognize() {
        return { candidates: [], provider: 'mock', latencyMs: 1, costCny: 0 }
      },
    }
    registerAdapter(failing)
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)

    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    if (error?.type === 'error') expect(error.fallbackText).toContain('再问一遍')
  })
})

describe('语音链路', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetTtsAdapter()
  })

  test('每句话都跟一个 audio 事件，且紧跟在对应的 sentence 之后', async () => {
    registerAdapter(chunkedAdapter(['第一句话在这里。', '第二句话也在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const ordered = events
      .filter((e) => e.type === 'sentence' || e.type === 'audio')
      .map((e) => `${e.type}:${e.type === 'sentence' || e.type === 'audio' ? e.index : ''}`)

    expect(ordered).toEqual(['sentence:0', 'audio:0', 'sentence:1', 'audio:1'])
  })

  test('audio 事件给 audioKey 而不是内联音频字节', async () => {
    registerAdapter(chunkedAdapter(['一句足够长的回答在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const audio = events.find((e) => e.type === 'audio')

    expect(audio).toBeDefined()
    if (audio?.type === 'audio') {
      expect(audio.audioKey).toMatch(/\.mp3$/)
      expect(JSON.stringify(audio)).not.toContain('base64')
    }
  })

  test('第二次问同样的话命中缓存，不再合成', async () => {
    registerAdapter(chunkedAdapter(['这是一句会被缓存的回答内容。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    await drain(journey.id, '第一次问')
    const second = await drain(journey.id, '第二次问')
    const audio = second.find((e) => e.type === 'audio')

    if (audio?.type === 'audio') expect(audio.cached).toBe(true)
  })

  test('TTS 未配置时降级为只显示文字，不发 audio 事件也不报错', async () => {
    vi.stubEnv('TTS_PROVIDER', 'volcengine')
    vi.stubEnv('VOLC_TTS_APP_ID', '')
    vi.stubEnv('VOLC_TTS_ACCESS_TOKEN', '')
    registerAdapter(chunkedAdapter(['一句足够长的回答在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)

    expect(events.filter((e) => e.type === 'audio')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'sentence').length).toBeGreaterThan(0)
    const done = events.find((e) => e.type === 'done')
    if (done?.type === 'done') {
      expect(done.timing.ttsProvider).toBeNull()
      expect(done.timing.firstAudioMs).toBeNull()
    }
  })

  test('时序里记下第一句语音就绪的时刻', async () => {
    registerAdapter(chunkedAdapter(['一句足够长的回答在这里。']))
    const userId = await createUser()
    const journey = await openJourney(userId)

    const events = await drain(journey.id)
    const done = events.find((e) => e.type === 'done')

    if (done?.type === 'done') {
      expect(done.timing.firstAudioMs).not.toBeNull()
      expect(done.timing.firstAudioMs ?? 0)
        .toBeGreaterThanOrEqual(done.timing.firstSentenceMs ?? 0)
    }
  })
})
