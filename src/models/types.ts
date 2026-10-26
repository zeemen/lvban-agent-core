/** Model Router 契约 —— 规格 03 §7。不绑定单一模型，控制 Quality × Latency × Cost。 */

export const MODEL_TASKS = [
  'intent', 'qa', 'planner', 'copy', 'vision', 'embedding',
] as const
export type ModelTask = (typeof MODEL_TASKS)[number]

/**
 * 规格 03 §7 延迟预算（ms）。这是**目标**而不是硬超时：
 * 超预算要记账告警，但不能因为慢 200ms 就把用户的回答掐掉。
 */
export const LATENCY_BUDGET_MS: Record<ModelTask, number> = {
  intent: 150,
  qa: 1200,
  planner: 800,
  copy: 1000,
  vision: 1500,
  embedding: 200,
}

export type CompletionRequest = {
  readonly task: ModelTask
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  readonly json?: boolean
}

export type CompletionResult = {
  readonly text: string
  readonly provider: string
  readonly task: ModelTask
  readonly latencyMs: number
  readonly tokensIn: number
  readonly tokensOut: number
  /**
   * 推理模型的思维链 token。它算在 tokensOut 里、要计费，但用户看不到。
   * deepseek-flash 回一句「收到」用了 36 个输出 token，其中 34 个是推理。
   */
  readonly reasoningTokens: number
  /** 供应商价格未经核实时为 null —— 宁可没有数字，不要有错的数字 */
  readonly costCny: number | null
  readonly cached: boolean
}

export type VisionRequest = {
  readonly imageKey: string
  /** 候选集约束：不做开放域识别（规格 02 §4.2） */
  readonly candidates: readonly { readonly exhibitId: string; readonly name: string }[]
}

export type VisionResult = {
  readonly candidates: readonly {
    readonly exhibitId: string; readonly name: string; readonly confidence: number
  }[]
  readonly provider: string
  readonly latencyMs: number
  readonly costCny: number | null
}

export type ModelAdapter = {
  readonly name: string
  complete(request: CompletionRequest): Promise<CompletionResult>
  recognize(request: VisionRequest): Promise<VisionResult>
}

/** 硬超时：延迟预算的 5 倍，且不低于 3 秒 */
export const hardTimeoutMs = (task: ModelTask): number =>
  Math.max(3_000, LATENCY_BUDGET_MS[task] * 5)
