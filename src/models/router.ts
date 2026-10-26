import { config } from '../config/index.js'
import { createMockAdapter } from './mock.js'
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

const pickAdapter = (): ModelAdapter => {
  const adapter = adapters.get(config.modelProvider)
  if (adapter === undefined) {
    throw new Error(
      `未注册的模型供应商：${config.modelProvider}。M2 仅内置 mock；` +
      `接真模型请在 src/models/ 下新增实现 ModelAdapter 的文件并在此注册。`,
    )
  }
  return adapter
}

export type RouterLedger = {
  readonly calls: number
  readonly costCny: number
  readonly byTask: Readonly<Record<string, number>>
  readonly overBudget: readonly string[]
}

type MutableLedger = {
  calls: number
  costCny: number
  byTask: Record<string, number>
  overBudget: string[]
}

const ledger: MutableLedger = { calls: 0, costCny: 0, byTask: {}, overBudget: [] }

const record = (task: ModelTask, result: { latencyMs: number; costCny: number }): void => {
  ledger.calls += 1
  ledger.costCny = Number((ledger.costCny + result.costCny).toFixed(6))
  ledger.byTask[task] = (ledger.byTask[task] ?? 0) + 1
  if (result.latencyMs > LATENCY_BUDGET_MS[task]) {
    ledger.overBudget = [...ledger.overBudget, `${task}:${result.latencyMs}ms`]
  }
}

export const readLedger = (): RouterLedger => ({
  calls: ledger.calls,
  costCny: ledger.costCny,
  byTask: { ...ledger.byTask },
  overBudget: [...ledger.overBudget],
})

export const resetLedger = (): void => {
  ledger.calls = 0
  ledger.costCny = 0
  ledger.byTask = {}
  ledger.overBudget = []
}

export const complete = async (request: CompletionRequest): Promise<CompletionResult> => {
  const result = await pickAdapter().complete(request)
  record(request.task, result)
  return result
}

export const recognize = async (request: VisionRequest): Promise<VisionResult> => {
  const result = await pickAdapter().recognize(request)
  record('vision', result)
  return result
}

export const registerAdapter = (adapter: ModelAdapter): void => {
  adapters.set(adapter.name, adapter)
}
