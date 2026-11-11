import { z } from 'zod'
import { ModelError } from './errors.js'
import { toImageUrl } from './image-url.js'
import { postJson } from './http.js'
import { streamSse, type StreamEvent } from './stream.js'
import {
  budgetWithReasoning, estimateCostCny, resolveModelId, resolveVision, thinkingParams,
  type ProviderProfile,
} from './providers.js'
import {
  hardTimeoutMs, type CompletionRequest, type CompletionResult,
  type ModelAdapter, type VisionRequest, type VisionResult,
} from './types.js'

/**
 * OpenAI 兼容适配器 —— 一份代码覆盖通义千问 / 豆包 / DeepSeek。
 *
 * 为什么是一个而不是三个：三家都实现了 /chat/completions 的 OpenAI 兼容形态，
 * 差异只在 baseUrl、模型 ID 命名和是否支持视觉——这些是数据，不是代码（见 providers.ts）。
 *
 * 未做（M2 不需要，有前端时再加）：流式输出。
 * 规格 03 §7 要求 TTS 首句 ≤600ms，真正落地时这里要改成 SSE 流式分句，
 * 现在没有消费流的前端，先不提前抽象。
 */

const choiceSchema = z.object({
  message: z.object({
    content: z.string().nullable(),
    // 推理模型把思维链放在这里，与 content 分开返回
    reasoning_content: z.string().nullable().optional(),
  }).optional(),
  finish_reason: z.string().nullable().optional(),
})

const completionSchema = z.object({
  choices: z.array(choiceSchema).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().optional(),
    }).optional(),
  }).optional(),
})

const visionPickSchema = z.object({
  exhibitId: z.string(),
  confidence: z.number().min(0).max(1),
})

/** 候选集约束识别的输出契约（规格 02 §4.2：不做开放域识别） */
const visionReplySchema = z.object({
  match: visionPickSchema.nullable(),
})

type Extracted = {
  readonly text: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly reasoningTokens: number
  readonly finishReason: string | null
}

const extractContent = (
  payload: unknown, provider: string, sentMaxTokens: number,
): Extracted => {
  const parsed = completionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ModelError({
      kind: 'parse', provider,
      message: `响应结构不符合 OpenAI 兼容格式：${parsed.error.message.slice(0, 200)}`,
    })
  }
  const choice = parsed.data.choices[0]
  const finishReason = choice?.finish_reason ?? null
  if (finishReason === 'content_filter') {
    throw new ModelError({
      kind: 'content_filter', provider, message: '内容被供应商安全策略拦截',
    })
  }

  const text = choice?.message?.content ?? ''
  const reasoningTokens =
    parsed.data.usage?.completion_tokens_details?.reasoning_tokens ?? 0

  /*
   * 推理模型会把思维链 token 算进 max_tokens：预算太小时思维链吃光额度，
   * content 为空而 finish_reason=length。这种情况必须报错而不是静默返回空串——
   * 否则 agent「说了话」但用户什么也没听到。
   */
  if (text.trim() === '' && finishReason === 'length') {
    throw new ModelError({
      kind: 'truncated', provider,
      message: `回答为空：max_tokens=${sentMaxTokens} 被思维链耗尽` +
        `（推理 ${reasoningTokens} token）。需要提高该供应商档案的 reasoning 预留量。`,
    })
  }

  return {
    text,
    tokensIn: parsed.data.usage?.prompt_tokens ?? 0,
    tokensOut: parsed.data.usage?.completion_tokens ?? 0,
    reasoningTokens,
    finishReason,
  }
}

const stripCodeFence = (text: string): string =>
  text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()

export type AdapterOptions = {
  readonly profile: ProviderProfile
  readonly apiKey: string
  /** 覆盖档案里的 baseUrl（如百炼的业务空间专属域名） */
  readonly baseUrl?: string
  readonly env?: NodeJS.ProcessEnv
}

export const createOpenAICompatibleAdapter = (options: AdapterOptions): ModelAdapter => {
  const { profile, apiKey } = options
  // 空字符串不算覆盖：MODEL_BASE_URL= 这种写法应当回落到档案值，
  // 否则 baseUrl 变成空串，请求打到 /chat/completions 这种相对路径上
  const overrideUrl = options.baseUrl === undefined || options.baseUrl === ''
    ? profile.baseUrl
    : options.baseUrl
  const baseUrl = overrideUrl.replace(/\/+$/, '')
  const env = options.env ?? process.env

  if (apiKey === '') {
    throw new Error(
      `供应商 ${profile.name} 需要 API Key：请设置环境变量 ${profile.apiKeyEnv} 或 MODEL_API_KEY`,
    )
  }

  return {
    name: profile.name,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const model = resolveModelId(profile, request.task, env)
      // request.maxTokens 是规格 03 §2 的**回答**长度；推理余量额外加
      const sentMaxTokens = budgetWithReasoning(profile, request.maxTokens, request.task, env)
      const { payload, latencyMs } = await postJson({
        url: `${baseUrl}/chat/completions`,
        apiKey,
        provider: profile.name,
        timeoutMs: hardTimeoutMs(request.task),
        body: {
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          max_tokens: sentMaxTokens,
          temperature: request.task === 'planner' ? 0 : 0.7,
          // 对话类任务关掉深度思考：首字延迟 3.7s → 1.2s（规格 03 §7 预算 1200ms）
          ...thinkingParams(profile, request.task, env),
          ...(request.json === true ? { response_format: { type: 'json_object' } } : {}),
        },
      })

      const extracted = extractContent(payload, profile.name, sentMaxTokens)
      return {
        text: request.json === true ? stripCodeFence(extracted.text) : extracted.text,
        provider: profile.name,
        task: request.task,
        latencyMs,
        tokensIn: extracted.tokensIn,
        tokensOut: extracted.tokensOut,
        reasoningTokens: extracted.reasoningTokens,
        costCny: estimateCostCny(profile, extracted.tokensIn, extracted.tokensOut),
        cached: false,
      }
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const model = resolveModelId(profile, request.task, env)
      const sentMaxTokens = budgetWithReasoning(profile, request.maxTokens, request.task, env)
      yield* streamSse({
        url: `${baseUrl}/chat/completions`,
        apiKey,
        provider: profile.name,
        timeoutMs: hardTimeoutMs(request.task),
        body: {
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          max_tokens: sentMaxTokens,
          temperature: request.task === 'planner' ? 0 : 0.7,
          stream: true,
          // 不带这个就拿不到 usage，账本会漏掉流式调用的 token
          stream_options: { include_usage: true },
          ...thinkingParams(profile, request.task, env),
        },
      })
    },

    async recognize(request: VisionRequest): Promise<VisionResult> {
      const verdict = resolveVision(profile, env)
      if (!verdict.available) {
        throw new ModelError({
          kind: 'bad_request', provider: profile.name,
          message: `${verdict.reason}。南博「拍一下」依赖视觉；` +
            `可用 MODEL_PROVIDER_VISION 为视觉任务单独指定一家供应商。`,
        })
      }
      if (request.candidates.length === 0) {
        return { candidates: [], provider: profile.name, latencyMs: 0, costCny: 0 }
      }

      const model = verdict.modelId
      const imageUrl = await toImageUrl(request.imageKey)
      const roster = request.candidates
        .map((c, i) => `${i + 1}. ${c.name}（exhibitId=${c.exhibitId}）`)
        .join('\n')

      // 候选集约束：不问「这是什么文物」，而问「是以下哪一件，或都不是」
      const system = [
        '你在博物馆展厅里帮助识别展品。',
        '只能从给定候选中选择，或判定都不是。严禁给出候选之外的答案。',
        '展柜玻璃常有反光、人流常有遮挡，判断不确定时要给低置信度而不是硬猜。',
        '只输出 JSON：{"match":{"exhibitId":"...","confidence":0.0}} 或 {"match":null}',
      ].join('\n')

      const { payload, latencyMs } = await postJson({
        url: `${baseUrl}/chat/completions`,
        apiKey,
        provider: profile.name,
        timeoutMs: hardTimeoutMs('vision'),
        body: {
          model,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: `候选展品：\n${roster}` },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: budgetWithReasoning(profile, 200, 'vision', env),
          ...thinkingParams(profile, 'vision', env),
          temperature: 0,
        },
      })

      const { text, tokensIn, tokensOut } = extractContent(
        payload, profile.name, budgetWithReasoning(profile, 200, 'vision', env),
      )
      const parsed = visionReplySchema.safeParse(
        JSON.parse(stripCodeFence(text) || '{"match":null}'),
      )
      if (!parsed.success) {
        throw new ModelError({
          kind: 'parse', provider: profile.name,
          message: `视觉识别返回体不符合约定格式：${text.slice(0, 120)}`,
        })
      }

      const match = parsed.data.match
      const known = new Map(request.candidates.map((c) => [c.exhibitId, c.name]))
      // 模型可能编一个候选集外的 ID —— 丢掉，等于「都不是」
      const name = match === null ? undefined : known.get(match.exhibitId)

      return {
        candidates: match === null || name === undefined
          ? []
          : [{ exhibitId: match.exhibitId, name, confidence: match.confidence }],
        provider: profile.name,
        latencyMs,
        costCny: estimateCostCny(profile, tokensIn, tokensOut),
      }
    },
  }
}
