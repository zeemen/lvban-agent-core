import type {
  CompletionRequest, CompletionResult, ModelAdapter, VisionRequest, VisionResult,
} from './types.js'

/**
 * Mock 适配器 —— M2 用它跑通端到端链路。
 *
 * 它不是玩具：Router 这层抽象本来就是规格 03 §7 要求的，mock 只是它的第一个实现。
 * 接真模型（通义千问 / 豆包 / DeepSeek）= 再加一个实现同一接口的文件。
 *
 * 行为上刻意做成「确定性 + 可识别」：输出带 [mock] 前缀，便于在端到端输出里
 * 一眼分清哪段是人工精调内容（锚点要素）、哪段是模型实时生成的。
 */

const BASE_LATENCY_MS = 40
const COST_PER_1K_TOKENS_CNY = 0.0008

const estimateTokens = (text: string): number => Math.ceil(text.length / 2)

const deterministicPick = <T>(items: readonly T[], seed: string): T | undefined => {
  if (items.length === 0) return undefined
  const sum = [...seed].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return items[sum % items.length]
}

const plannerJson = (): string => JSON.stringify({
  shouldSpeak: true, length: 'medium', register: 'peer', openWith: 'question',
  useStory: false, linkCurriculum: false, leaveHook: true,
})

export const createMockAdapter = (): ModelAdapter => ({
  name: 'mock',

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = request.json === true
      ? plannerJson()
      : `[mock:${request.task}] ${request.user.slice(0, 60)}`
    const tokensIn = estimateTokens(request.system + request.user)
    const tokensOut = estimateTokens(text)
    return {
      text,
      provider: 'mock',
      task: request.task,
      latencyMs: BASE_LATENCY_MS,
      tokensIn,
      tokensOut,
      costCny: Number((((tokensIn + tokensOut) / 1000) * COST_PER_1K_TOKENS_CNY).toFixed(6)),
      cached: false,
    }
  },

  async recognize(request: VisionRequest): Promise<VisionResult> {
    // 确定性地选一个候选并给出 0.82 置信度：高于 τ_high(0.75)，走 auto_accept 分支
    const picked = deterministicPick(request.candidates, request.imageKey)
    return {
      candidates: picked === undefined
        ? []
        : [{ exhibitId: picked.exhibitId, name: picked.name, confidence: 0.82 }],
      provider: 'mock',
      latencyMs: BASE_LATENCY_MS,
      costCny: 0.000013,
    }
  },
})
