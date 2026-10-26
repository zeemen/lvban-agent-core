import type { ModelTask } from './types.js'

/**
 * 供应商档案表 —— 规格 03 §7 Model Router 的落地数据。
 *
 * 设计前提：三家国内供应商都提供 OpenAI 兼容的 chat completions 接口，
 * 所以只需要一个适配器 + 一张档案表，而不是三个适配器。
 *
 * ⚠ 模型 ID **刻意不写死**。核实时发现 DeepSeek 官方文档已把 `deepseek-chat`
 * 换成 `deepseek-flash` / `deepseek-v4-pro`，旧名虽被接受但模型已下线。
 * 模型 ID 的变动频率远高于代码发布频率，所以档案里的只是「上次核实时的默认值」，
 * 一律可被 MODEL_ID_<TASK> 覆盖，并提供 `node --run models:probe` 用真实 Key 去问供应商。
 *
 * ⚠ 视觉能力是**模型**的属性，不是供应商的属性。
 * 同一个 DeepSeek 账号，deepseek-flash 接受图像，deepseek-v4-pro 不接受。
 * 所以这里按模型 ID 判定，而不是给供应商打一个 supportsVision 布尔值。
 *
 * ⚠ 价格未经官方页面核实就不写入。DeepSeek 还分高峰/空闲时段计价
 * （空闲为高峰的一半），静态价格表必然有一半时间是错的。
 * 没有 pricing 的档案，账本只统计 token 数、costCny 返回 null。
 */

export type Pricing = {
  /** 元 / 百万 token */
  readonly inputCnyPerMillion: number
  readonly outputCnyPerMillion: number
  readonly verifiedAt: string
  readonly source: string
}

/** 怎么判断某个模型 ID 能不能吃图片 */
export type VisionSupport =
  /** 能按模型 ID 判定（模型名有规律） */
  | {
      readonly kind: 'by_model'
      readonly pattern: RegExp
      readonly examples: readonly string[]
      readonly verifiedAt: string
      readonly source: string
    }
  /** model 字段是不透明的接入点 ID，从 ID 看不出能力，只能交给供应商报错 */
  | { readonly kind: 'opaque' }
  /** 整家都没有视觉能力 */
  | { readonly kind: 'none' }

/**
 * 推理模型的 token 预算处理。
 *
 * 推理模型把思维链 token 也算进 max_tokens，所以规格 03 §2 按年龄段设的
 * 「回答长度」不能直接当 max_tokens 发出去——否则预算会被看不见的推理吃掉，
 * 低龄档 90 token 那种配置会直接拿到空回答。
 * 这里额外预留一段推理余量：它是上限而不是消费目标，真实花费按实际 token 计。
 */
export type ReasoningBudget =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'reserve'
      /** 至少额外预留多少 token 给思维链 */
      readonly minTokens: number
      /** 按回答长度的倍数额外预留 */
      readonly multiplier: number
      readonly verifiedAt: string
      readonly source: string
    }

export type ProviderProfile = {
  readonly name: string
  readonly label: string
  readonly baseUrl: string
  readonly baseUrlVerifiedAt: string
  readonly baseUrlSource: string
  readonly apiKeyEnv: string
  readonly vision: VisionSupport
  readonly reasoning: ReasoningBudget
  /** 调用时 model 字段填的是模型 ID，还是账号自有的推理接入点 ID */
  readonly modelFieldKind: 'model_id' | 'endpoint_id'
  /** 上次核实时的默认模型 ID；可被 MODEL_ID_<TASK> 覆盖 */
  readonly defaultModels: Partial<Record<ModelTask, string>>
  readonly pricing?: Pricing
  readonly notes: readonly string[]
}

export const PROVIDERS: Readonly<Record<string, ProviderProfile>> = {
  dashscope: {
    name: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlVerifiedAt: '2026-10-25',
    baseUrlSource: 'help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    vision: {
      kind: 'by_model',
      pattern: /^(qwen-?vl|qvq)/i,
      examples: ['qwen-vl-max', 'qwen-vl-plus'],
      verifiedAt: '2026-10-25',
      source: 'help.aliyun.com/zh/model-studio/qwen-vl-compatible-with-openai',
    },
    reasoning: { kind: 'none' },
    modelFieldKind: 'model_id',
    defaultModels: {
      intent: 'qwen-turbo',
      qa: 'qwen-plus',
      planner: 'qwen-max',
      copy: 'qwen-plus',
      vision: 'qwen-vl-max',
      embedding: 'text-embedding-v3',
    },
    notes: [
      '一个 Key 同时覆盖文本与视觉两条链路',
      '新版文档另给业务空间专属域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1；旧域名仍可用，需要时用 MODEL_BASE_URL 覆盖',
      '各地域支持的模型不同，上线前以控制台列表为准',
    ],
  },

  ark: {
    name: 'ark',
    label: '火山引擎方舟 / 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    baseUrlVerifiedAt: '2026-10-25',
    baseUrlSource: 'volcengine.com/docs/82379/1330626',
    apiKeyEnv: 'ARK_API_KEY',
    // 接入点 ID（ep-xxxx）看不出模型能力，只能调用后由供应商报错
    vision: { kind: 'opaque' },
    // 接入点背后是什么模型未知；豆包部分模型会深度思考，保守预留
    reasoning: {
      kind: 'reserve', minTokens: 128, multiplier: 1,
      verifiedAt: '2026-10-25', source: '保守默认值，未实测',
    },
    modelFieldKind: 'endpoint_id',
    defaultModels: {},
    notes: [
      'model 字段多数情况下要填控制台创建的推理接入点 ID（形如 ep-xxxx），因此没有可预置的默认值',
      '必须用 MODEL_ID_QA / MODEL_ID_VISION 等环境变量逐项指定',
      '接入点 ID 不透明：视觉能力无法从 ID 判断，配错只能由调用报错暴露',
      '自带超拟人 TTS，规格 03 的语音链路后续会用到同一账号',
    ],
  },

  deepseek: {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    baseUrlVerifiedAt: '2026-10-25',
    baseUrlSource: 'api-docs.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    vision: {
      kind: 'by_model',
      // deepseek-flash 接受图像；deepseek-v4-pro 不接受
      pattern: /^deepseek-flash|vision/i,
      examples: ['deepseek-flash'],
      verifiedAt: '2026-10-25',
      source: 'api-docs.deepseek.com/guides/vision',
    },
    // 实测：deepseek-flash 回一句「收到」用掉 36 输出 token，其中 34 是推理；
    // max_tokens=16 时 content 为空、finish_reason=length
    reasoning: {
      kind: 'reserve', minTokens: 256, multiplier: 2,
      verifiedAt: '2026-10-25', source: '本机实测 api.deepseek.com',
    },
    modelFieldKind: 'model_id',
    defaultModels: {
      intent: 'deepseek-flash',
      qa: 'deepseek-flash',
      planner: 'deepseek-v4-pro',
      copy: 'deepseek-flash',
      // 视觉必须显式用 flash：v4-pro 不吃图片
      vision: 'deepseek-flash',
    },
    notes: [
      '官方文档当前列出 deepseek-flash 与 deepseek-v4-pro；deepseek-chat / deepseek-reasoner 已不在文档中',
      '视觉只有 deepseek-flash 支持；deepseek-v4-pro 不接受图像输入',
      '旧名 deepseek-v4-flash-vision-exp 仍被接受，请求由最新 Flash 承接',
      '价格分高峰/空闲时段（空闲为高峰一半，高峰为北京时间 9:00–12:00 与 14:00–18:00），因此未写入静态 pricing',
      '图片上限极宽松（单图 32MiB）；我们自己压到 300KB 是规格 02 §4.2 的产品约束，不是供应商限制',
      '两个模型都是推理模型：reasoning_content 与 content 分开返回，推理 token 计入 max_tokens 且计费',
      '实测延迟：文本 1.5–2.7s、视觉 1.9s 起（偶尔破 5s），均远超规格 03 §7 的 1200/1500ms 预算 —— 需要流式输出 + 预置垫音',
      '实测推理开销：回一句「收到」用掉 31–47 输出 token，其中 94%+ 是思维链；JSON 规划调用约 104 推理 token',
    ],
  },
} as const

export const resolveProfile = (name: string): ProviderProfile => {
  const profile = PROVIDERS[name]
  if (profile === undefined) {
    throw new Error(
      `未知的模型供应商：${name}。可选：${Object.keys(PROVIDERS).join(' / ')} / mock`,
    )
  }
  return profile
}

/** 任务 → 模型 ID。环境变量优先，档案默认值兜底。 */
export const resolveModelId = (
  profile: ProviderProfile, task: ModelTask, env: NodeJS.ProcessEnv = process.env,
): string => {
  const override = env[`MODEL_ID_${task.toUpperCase()}`]
  if (override !== undefined && override !== '') return override

  const fallback = profile.defaultModels[task]
  if (fallback !== undefined) return fallback

  throw new Error(
    `供应商 ${profile.name} 没有为任务「${task}」预置模型 ID` +
    `（modelFieldKind=${profile.modelFieldKind}）。` +
    `请设置环境变量 MODEL_ID_${task.toUpperCase()}。` +
    `先运行 node --run models:probe 查看该 Key 实际可用的模型。`,
  )
}

export type VisionVerdict =
  | { readonly available: true; readonly modelId: string; readonly certain: boolean }
  | { readonly available: false; readonly reason: string }

/**
 * 这个供应商 + 这个模型，到底能不能吃图片。
 *
 * certain=false 表示「不确定但允许尝试」（方舟的不透明接入点 ID）：
 * 调用可能失败，由供应商的错误来暴露，而不是我们提前拒绝一个其实可用的配置。
 */
export const resolveVision = (
  profile: ProviderProfile, env: NodeJS.ProcessEnv = process.env,
): VisionVerdict => {
  if (profile.vision.kind === 'none') {
    return {
      available: false,
      reason: `${profile.label} 不提供视觉能力`,
    }
  }

  let modelId: string
  try {
    modelId = resolveModelId(profile, 'vision', env)
  } catch {
    return {
      available: false,
      reason: `${profile.label} 未配置 vision 任务的模型 ID（设 MODEL_ID_VISION）`,
    }
  }

  if (profile.vision.kind === 'opaque') {
    return { available: true, modelId, certain: false }
  }

  if (!profile.vision.pattern.test(modelId)) {
    return {
      available: false,
      reason: `模型 ${modelId} 不接受图像输入。` +
        `${profile.label} 的视觉模型形如 ${profile.vision.examples.join(' / ')}，` +
        `请用 MODEL_ID_VISION 指定。`,
    }
  }

  return { available: true, modelId, certain: true }
}

export const estimateCostCny = (
  profile: ProviderProfile, tokensIn: number, tokensOut: number,
): number | null => {
  if (profile.pricing === undefined) return null
  const { inputCnyPerMillion, outputCnyPerMillion } = profile.pricing
  const cost =
    (tokensIn / 1_000_000) * inputCnyPerMillion +
    (tokensOut / 1_000_000) * outputCnyPerMillion
  return Number(cost.toFixed(6))
}

/**
 * 实际要发给供应商的 max_tokens。
 * 规格 03 §2 的年龄段长度是**回答**长度，推理余量额外加。
 */
export const budgetWithReasoning = (
  profile: ProviderProfile, answerTokens: number,
): number => {
  if (profile.reasoning.kind === 'none') return answerTokens
  const { minTokens, multiplier } = profile.reasoning
  return answerTokens + Math.max(minTokens, Math.ceil(answerTokens * multiplier))
}
