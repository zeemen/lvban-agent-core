// 读取 .env 里的真实 Key，供 PROBE_PROVIDER 那组用。
// dotenv 默认不覆盖已有变量，所以 vitest 钉住的 MODEL_PROVIDER=mock 不受影响。
import 'dotenv/config'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMockAdapter } from '../../src/models/mock.js'
import { createOpenAICompatibleAdapter } from '../../src/models/openai-compatible.js'
import { resolveProfile } from '../../src/models/providers.js'
import type { ModelAdapter } from '../../src/models/types.js'

/**
 * 适配器契约 —— 任何 ModelAdapter 实现都必须满足的断言。
 *
 * 同一套断言跑两种对象：
 *   1. mock 适配器（永远跑）
 *   2. 真实供应商（设了 PROBE_PROVIDER + 对应 Key 才跑，否则跳过）
 *
 * Key 到位后的验收方式：
 *   PROBE_PROVIDER=dashscope DASHSCOPE_API_KEY=sk-xxx node --run test
 */

/**
 * 一张 64×64 的合成小图，内嵌为 data URI。
 * 契约测试要能对真实供应商跑，所以 imageKey 必须是真能被解析的东西——
 * 假 key（如 'contract-test-key'）只有 mock 吃得下。
 */
const TINY_IMAGE_DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpKKKK8c7woqOe4htozJNIsajuT1/xrIn8TQI2IIHlAJyWO0fh1/pRYDborCi8URFv3tq6LjqjBjn9K17a7t7tN9vKsgHXHUfUdRTsBNRRRSAKjuJ0toHmkOFQZPv7VJWJ4mnZLWGAZAkYkkHsO36/pQgMW/v5tQn8yThRwiA8KP8APeqtFFaCCprW6ms51mhbDDqOxHoahooA7exvEvrVZ0GM8Muc7T6VYrnPDE7Caa35Ksu8c8Ag46e+R+VdHUMYVheKImMNvLkbVYqfXJH/ANY1u1Dd2y3drJbvwHGM+h7H86EBw1FTXVrNZztDMuGHQ9iPUVDViCiinwwyTyrFEhd2OABQBr+GImN3NLkbVj2n1yT/APWNdLVTTLIWFksOQXJ3OR0J/wA4H4VbqGMKKKKQFe8sbe+jCTpnGdrA4K/SsSfwxKG/0e4RlJPEgIIHbpnP6V0dFO4HNReGLgt+9uI0XHVAWOf0rastMtrAHyVJcjBdjkkVboouAUUUUgP/2Q=='

const CANDIDATES = [
  { exhibitId: 'njm_cuojinyin_hu', name: '错金银重络铜壶' },
  { exhibitId: 'njm_zhulin_qixian', name: '竹林七贤与荣启期砖画' },
]

/**
 * 真实供应商是推理模型 + 网络调用：实测文本 1.5–2.7s、视觉 2.9s 以上（偶尔破 5s）。
 * vitest 默认 5s 会误判超时，所以这组断言给足余量。
 * 这个数字本身就是一条结论：规格 03 §7 给 vision 的 1500ms 预算在真实链路上不成立。
 */
const REAL_CALL_TIMEOUT_MS = 30_000

const contractFor = (name: string, makeAdapter: () => ModelAdapter): void => {
  describe(`适配器契约：${name}`, () => {
    test('complete 返回非空文本与 token 计数', async () => {
      const adapter = makeAdapter()

      const result = await adapter.complete({
        task: 'qa', system: '只回复两个字：收到', user: '连通性测试', maxTokens: 32,
      })

      expect(result.text).not.toBe('')
      expect(result.provider).toBe(adapter.name)
      expect(result.task).toBe('qa')
      expect(result.tokensIn).toBeGreaterThanOrEqual(0)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    }, REAL_CALL_TIMEOUT_MS)

    test('costCny 要么是数字，要么是 null —— 不能是编出来的 0', async () => {
      const adapter = makeAdapter()

      const result = await adapter.complete({
        task: 'qa', system: 's', user: 'u', maxTokens: 16,
      })

      expect(result.costCny === null || typeof result.costCny === 'number').toBe(true)
    }, REAL_CALL_TIMEOUT_MS)

    test('json 模式返回可解析的 JSON', async () => {
      const adapter = makeAdapter()

      const result = await adapter.complete({
        task: 'planner',
        system: '只输出 JSON 对象，键为 ok，值为 true',
        user: '测试',
        maxTokens: 64,
        json: true,
      })

      expect(() => JSON.parse(result.text)).not.toThrow()
    }, REAL_CALL_TIMEOUT_MS)

    test('recognize 的结果只能落在候选集内', async () => {
      const adapter = makeAdapter()

      const result = await adapter.recognize({
        imageKey: TINY_IMAGE_DATA_URI, candidates: CANDIDATES,
      })

      const allowed = new Set(CANDIDATES.map((c) => c.exhibitId))
      for (const candidate of result.candidates) {
        expect(allowed.has(candidate.exhibitId)).toBe(true)
        expect(candidate.confidence).toBeGreaterThanOrEqual(0)
        expect(candidate.confidence).toBeLessThanOrEqual(1)
      }
    }, REAL_CALL_TIMEOUT_MS)

    test('候选集为空时返回空结果，不做开放域识别', async () => {
      const adapter = makeAdapter()

      const result = await adapter.recognize({
        imageKey: TINY_IMAGE_DATA_URI, candidates: [],
      })

      expect(result.candidates).toEqual([])
    })
  })
}

contractFor('mock', createMockAdapter)

// ── 真实供应商：有 Key 才跑 ──────────────────────────────────────
const probeProvider = process.env.PROBE_PROVIDER
const probeKey = probeProvider === undefined
  ? ''
  : process.env[resolveProfile(probeProvider).apiKeyEnv] ?? process.env.MODEL_API_KEY ?? ''

describe.skipIf(probeProvider === undefined || probeKey === '')(
  `真实供应商（${probeProvider ?? '未配置'}）`,
  () => {
    contractFor(probeProvider ?? 'unset', () => createOpenAICompatibleAdapter({
      profile: resolveProfile(probeProvider as string),
      apiKey: probeKey,
      baseUrl: process.env.MODEL_BASE_URL,
    }))
  },
)

// ── 请求体形状：用假 fetch 验证，不需要 Key ───────────────────────
describe('OpenAI 兼容适配器的请求体', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const dashscope = resolveProfile('dashscope')

  const stubFetch = (reply: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(reply), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const textReply = (content: string) => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  })

  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> =>
    JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body)

  test('缺少 API Key 时在创建适配器时就报错，而不是调用时', () => {
    expect(() => createOpenAICompatibleAdapter({ profile: dashscope, apiKey: '' }))
      .toThrow(/DASHSCOPE_API_KEY/)
  })

  test('打到 /chat/completions，带 Bearer 鉴权', async () => {
    const fetchMock = stubFetch(textReply('收到'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    await adapter.complete({ task: 'qa', system: 's', user: 'u', maxTokens: 16 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  })

  test('空字符串的 baseUrl 覆盖被忽略，回落到档案值', async () => {
    const fetchMock = stubFetch(textReply('收到'))
    const adapter = createOpenAICompatibleAdapter({
      profile: dashscope, apiKey: 'sk-test', baseUrl: '',
    })

    await adapter.complete({ task: 'qa', system: 's', user: 'u', maxTokens: 16 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
  })

  test('baseUrl 可被覆盖，且结尾斜杠不会产生双斜杠', async () => {
    const fetchMock = stubFetch(textReply('收到'))
    const adapter = createOpenAICompatibleAdapter({
      profile: dashscope, apiKey: 'sk-test',
      baseUrl: 'https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/',
    })

    await adapter.complete({ task: 'qa', system: 's', user: 'u', maxTokens: 16 })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
  })

  test('planner 任务用温度 0 —— 决策要可回放', async () => {
    const fetchMock = stubFetch(textReply('{"ok":true}'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    await adapter.complete({
      task: 'planner', system: 's', user: 'u', maxTokens: 64, json: true,
    })

    const body = bodyOf(fetchMock)
    expect(body.temperature).toBe(0)
    expect(body.model).toBe('qwen-max')
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  test('json 模式会剥掉模型套的 ```json 代码围栏', async () => {
    stubFetch(textReply('```json\n{"ok":true}\n```'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    const result = await adapter.complete({
      task: 'planner', system: 's', user: 'u', maxTokens: 64, json: true,
    })

    expect(JSON.parse(result.text)).toEqual({ ok: true })
  })

  test('finish_reason=content_filter 被识别为内容拦截，不当成空回答', async () => {
    stubFetch({
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
    })
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    await expect(adapter.complete({ task: 'qa', system: 's', user: 'u', maxTokens: 16 }))
      .rejects.toMatchObject({ kind: 'content_filter' })
  })

  test('视觉请求把候选集写进提示词，并用多模态 content 数组传图', async () => {
    const fetchMock = stubFetch(textReply('{"match":{"exhibitId":"njm_cuojinyin_hu","confidence":0.83}}'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    const result = await adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })

    const body = bodyOf(fetchMock)
    const messages = body.messages as { role: string; content: unknown }[]
    const userContent = messages[1]?.content as { type: string }[]
    expect(userContent.map((c) => c.type)).toEqual(['text', 'image_url'])
    expect(JSON.stringify(userContent)).toContain('njm_cuojinyin_hu')
    expect(result.candidates[0]?.confidence).toBe(0.83)
  })

  test('模型编造候选集外的 exhibitId 时结果被丢弃，等于「都不是」', async () => {
    stubFetch(textReply('{"match":{"exhibitId":"njm_bu_cun_zai","confidence":0.95}}'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    const result = await adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })

    expect(result.candidates).toEqual([])
  })

  test('模型判定都不是时返回空候选', async () => {
    stubFetch(textReply('{"match":null}'))
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    const result = await adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })

    expect(result.candidates).toEqual([])
  })

  test('视觉模型选错时报错并指出该换成什么', async () => {
    // DeepSeek 有视觉，但只有 deepseek-flash 吃图片；v4-pro 不吃
    const adapter = createOpenAICompatibleAdapter({
      profile: resolveProfile('deepseek'),
      apiKey: 'sk-test',
      env: { MODEL_ID_VISION: 'deepseek-v4-pro' },
    })

    await expect(adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })).rejects.toThrow(/deepseek-flash[\s\S]*MODEL_ID_VISION|MODEL_ID_VISION[\s\S]*deepseek-flash/)
  })

  test('视觉模型选对时不报能力错误（deepseek-flash 吃图片）', async () => {
    stubFetch(textReply('{"match":null}'))
    const adapter = createOpenAICompatibleAdapter({
      profile: resolveProfile('deepseek'),
      apiKey: 'sk-test',
      env: { MODEL_ID_VISION: 'deepseek-flash' },
    })

    const result = await adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })

    expect(result.candidates).toEqual([])
  })

  test('报错里带上「可为视觉任务单独指定供应商」的出路', async () => {
    const adapter = createOpenAICompatibleAdapter({
      profile: resolveProfile('deepseek'),
      apiKey: 'sk-test',
      env: { MODEL_ID_VISION: 'deepseek-v4-pro' },
    })

    await expect(adapter.recognize({
      imageKey: 'https://example.test/a.jpg', candidates: CANDIDATES,
    })).rejects.toThrow(/MODEL_PROVIDER_VISION/)
  })

  test('读不到本地图片时报错提示 imageKey 的合法形态', async () => {
    const adapter = createOpenAICompatibleAdapter({ profile: dashscope, apiKey: 'sk-test' })

    await expect(adapter.recognize({
      imageKey: '/tmp/does-not-exist-12345.jpg', candidates: CANDIDATES,
    })).rejects.toThrow(/imageKey/)
  })
})
