import { config, resolveApiKey, resolveProviderFor } from '../config/index.js'
import { createMockAdapter } from './mock.js'
import { createOpenAICompatibleAdapter } from './openai-compatible.js'
import { resolveProfile, resolveVision, type VisionVerdict } from './providers.js'
import type { StreamEvent } from './stream.js'
import {
  LATENCY_BUDGET_MS, type CompletionRequest, type CompletionResult,
  type ModelAdapter, type ModelTask, type VisionRequest, type VisionResult,
} from './types.js'

/**
 * Model Router —— 规格 03 §7。
 *
 * 职责：按任务分档路由、记账、超预算告警、缓存命中。
 * 规格 03 §7.2：Top 30 锚点开场段可全量预生成并缓存，个性化部分才实时生成。
 */

const adapters = new Map<string, ModelAdapter>([['mock', createMockAdapter()]])

/**
 * 按任务挑适配器。真实供应商的适配器按需创建：
 * 进程起来时不要求 Key 存在，只有真的要调模型时才报「缺 Key」——
 * 否则本地只跑测试也会被挡住。
 */
const pickAdapter = (task: ModelTask): ModelAdapter => {
  const providerName = resolveProviderFor(task)
  const existing = adapters.get(providerName)
  if (existing !== undefined) return existing

  const profile = resolveProfile(providerName)
  const adapter = createOpenAICompatibleAdapter({
    profile,
    apiKey: resolveApiKey(profile.apiKeyEnv),
    baseUrl: config.modelBaseUrl,
  })
  adapters.set(profile.name, adapter)
  return adapter
}

export type RouterLedger = {
  readonly calls: number
  readonly costCny: number
  /** 供应商价格未核实时无法计价的调用数：costCny 偏低就是因为它 */
  readonly unpricedCalls: number
  readonly tokensIn: number
  readonly tokensOut: number
  /** 其中用户看不见但要计费的思维链 token */
  readonly reasoningTokens: number
  readonly byTask: Readonly<Record<string, number>>
  readonly overBudget: readonly string[]
}

type MutableLedger = {
  calls: number
  costCny: number
  unpricedCalls: number
  tokensIn: number
  tokensOut: number
  reasoningTokens: number
  byTask: Record<string, number>
  overBudget: string[]
}

const emptyLedger = (): MutableLedger => ({
  calls: 0, costCny: 0, unpricedCalls: 0, tokensIn: 0, tokensOut: 0,
  reasoningTokens: 0, byTask: {}, overBudget: [],
})

const ledger: MutableLedger = emptyLedger()

const record = (task: ModelTask, result: {
  readonly latencyMs: number
  readonly costCny: number | null
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly reasoningTokens?: number
}): void => {
  ledger.calls += 1
  if (result.costCny === null) ledger.unpricedCalls += 1
  else ledger.costCny = Number((ledger.costCny + result.costCny).toFixed(6))
  ledger.tokensIn += result.tokensIn ?? 0
  ledger.tokensOut += result.tokensOut ?? 0
  ledger.reasoningTokens += result.reasoningTokens ?? 0
  ledger.byTask[task] = (ledger.byTask[task] ?? 0) + 1
  if (result.latencyMs > LATENCY_BUDGET_MS[task]) {
    ledger.overBudget = [...ledger.overBudget, `${task}:${result.latencyMs}ms`]
  }
}

export const readLedger = (): RouterLedger => ({
  calls: ledger.calls,
  costCny: ledger.costCny,
  unpricedCalls: ledger.unpricedCalls,
  tokensIn: ledger.tokensIn,
  tokensOut: ledger.tokensOut,
  reasoningTokens: ledger.reasoningTokens,
  byTask: { ...ledger.byTask },
  overBudget: [...ledger.overBudget],
})

export const resetLedger = (): void => {
  Object.assign(ledger, emptyLedger())
}

export const complete = async (request: CompletionRequest): Promise<CompletionResult> => {
  const result = await pickAdapter(request.task).complete(request)
  record(request.task, result)
  return result
}

/**
 * 流式调用。记账在流结束时一次性做——中途没有 usage 可记。
 */
export async function* stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
  const adapter = pickAdapter(request.task)
  const started = Date.now()
  for await (const event of adapter.stream(request)) {
    if (event.type === 'done') {
      record(request.task, {
        latencyMs: Date.now() - started,
        costCny: null,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        reasoningTokens: event.reasoningTokens,
      })
    }
    yield event
  }
}

export const recognize = async (request: VisionRequest): Promise<VisionResult> => {
  const result = await pickAdapter('vision').recognize(request)
  record('vision', result)
  return result
}

export const registerAdapter = (adapter: ModelAdapter): void => {
  adapters.set(adapter.name, adapter)
}

/**
 * 视觉链路现在可用吗。
 *
 * 规格 02 §4 的「拍一下 / 问一句」双入口里，「拍一下」依赖 VLM。
 * 配置不支持视觉时，正确行为是让产品降级到「问一句」为主
 * （与 §4.3 命中率熔断同一条路径），而不是在用户点下快门后抛错。
 */
export const visionAvailability = (): VisionVerdict => {
  const providerName = resolveProviderFor('vision')
  if (providerName === 'mock') {
    return { available: true, modelId: 'mock', certain: true }
  }
  try {
    const profile = resolveProfile(providerName)

    // 缺 Key 和模型不支持视觉是同一类问题：这个配置根本不可能成功，
    // 必须在用户按下快门之前就判定不可用，而不是在调用时抛错。
    if (resolveApiKey(profile.apiKeyEnv) === '') {
      return {
        available: false,
        reason: `${profile.label} 未设置 API Key（${profile.apiKeyEnv}）`,
      }
    }

    return resolveVision(profile)
  } catch (error) {
    return { available: false, reason: (error as Error).message }
  }
}
