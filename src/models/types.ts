/** Model Router 契约 —— 规格 03 §7。不绑定单一模型，控制 Quality × Latency × Cost。 */

export const MODEL_TASKS = [
  'intent', 'qa', 'planner', 'copy', 'vision', 'embedding',
] as const
export type ModelTask = (typeof MODEL_TASKS)[number]

/** 规格 03 §7 延迟预算（ms） */
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
  readonly costCny: number
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
  readonly costCny: number
}

export type ModelAdapter = {
  readonly name: string
  complete(request: CompletionRequest): Promise<CompletionResult>
  recognize(request: VisionRequest): Promise<VisionResult>
}
