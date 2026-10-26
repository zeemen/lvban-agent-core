import { config, resolveApiKey } from '../config/index.js'
import { ModelError } from './errors.js'
import { getJson } from './http.js'
import { createOpenAICompatibleAdapter } from './openai-compatible.js'
import { PROVIDERS, resolveModelId, resolveProfile, resolveVision } from './providers.js'
import { MODEL_TASKS, type ModelTask } from './types.js'

/**
 * 用真实 Key 探测供应商 —— 回答三个问题：
 *   1. Key 能用吗
 *   2. 这个账号实际能调哪些模型（而不是文档上写的）
 *   3. 我们按任务配的模型 ID，真的调得通吗
 *
 * 存在的理由：模型 ID 的变动频率远高于代码发布频率。
 * 核实档案表时就撞上了 DeepSeek 把 deepseek-chat 换成 deepseek-flash，
 * 所以靠文档和记忆都不可靠，只能问供应商本人。
 */

type ProbeOutcome = { readonly ok: boolean; readonly detail: string }

const listModels = async (baseUrl: string, apiKey: string, provider: string): Promise<ProbeOutcome> => {
  try {
    const payload = await getJson({
      url: `${baseUrl.replace(/\/+$/, '')}/models`,
      apiKey, provider, timeoutMs: 10_000,
    })
    const body = payload as { data?: { id?: string }[] }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => id !== undefined)
    if (ids.length === 0) {
      return { ok: true, detail: '接口可达，但未返回模型列表（部分供应商不开放 /models）' }
    }
    return { ok: true, detail: `${ids.length} 个可用模型：\n    ${ids.sort().join('\n    ')}` }
  } catch (error) {
    if (error instanceof ModelError) {
      return { ok: false, detail: `${error.kind} —— ${error.message}` }
    }
    throw error
  }
}

const probeTask = async (
  providerName: string, task: ModelTask,
): Promise<ProbeOutcome> => {
  const profile = resolveProfile(providerName)

  let modelId: string
  try {
    modelId = resolveModelId(profile, task)
  } catch (error) {
    return { ok: false, detail: `未配置模型 ID（${(error as Error).message.split('。')[0]}）` }
  }

  if (task === 'embedding') {
    return { ok: true, detail: `${modelId}（embedding 探测未实现，跳过）` }
  }

  const adapter = createOpenAICompatibleAdapter({
    profile, apiKey: resolveApiKey(profile.apiKeyEnv), baseUrl: config.modelBaseUrl,
  })

  if (task === 'vision') {
    const verdict = resolveVision(profile)
    if (!verdict.available) {
      return { ok: false, detail: verdict.reason }
    }
    const certainty = verdict.certain ? '' : '（接入点 ID 不透明，能力待实际调用验证）'
    return {
      ok: true,
      detail: `${verdict.modelId}${certainty} —— 用 node --run models:probe <图片路径> 实测`,
    }
  }

  try {
    const result = await adapter.complete({
      task,
      system: '只回复两个字：收到',
      user: '连通性测试',
      maxTokens: 16,
    })
    const cost = result.costCny === null ? '价格未核实' : `¥${result.costCny}`
    const reasoning = result.reasoningTokens > 0
      ? `（含思维链 ${result.reasoningTokens}）` : ''
    return {
      ok: true,
      detail: `${modelId} · ${result.latencyMs}ms · 入 ${result.tokensIn} / 出 ${result.tokensOut}${reasoning}` +
        ` · ${cost} · 回复「${result.text.trim().slice(0, 20)}」`,
    }
  } catch (error) {
    if (error instanceof ModelError) {
      return { ok: false, detail: `${modelId} —— ${error.kind}：${error.message}` }
    }
    throw error
  }
}

const probeVision = async (providerName: string, imagePath: string): Promise<void> => {
  const profile = resolveProfile(providerName)
  const adapter = createOpenAICompatibleAdapter({
    profile, apiKey: resolveApiKey(profile.apiKeyEnv), baseUrl: config.modelBaseUrl,
  })
  const { loadAnchors } = await import('../content/loader.js')
  const anchors = await loadAnchors()
  const candidates = [...anchors.values()]
    .filter((a) => a.exhibitId !== undefined)
    .map((a) => ({ exhibitId: a.exhibitId as string, name: a.name }))

  console.log(`候选集（${candidates.length} 件）：${candidates.map((c) => c.name).join('、')}`)
  const result = await adapter.recognize({ imageKey: imagePath, candidates })
  console.log(`识别结果：${JSON.stringify(result, null, 2)}`)
}

const run = async (): Promise<void> => {
  // process.argv = [node, script, ...args]
  const maybeImage = process.argv[2]
  const providerName = config.modelProvider

  if (providerName === 'mock') {
    console.log('MODEL_PROVIDER=mock —— 无需探测。')
    console.log(`\n可选的真实供应商：`)
    for (const p of Object.values(PROVIDERS)) {
      console.log(`\n  ${p.name}（${p.label}）`)
      console.log(`    baseUrl   ${p.baseUrl}`)
      console.log(`    Key 环境变量 ${p.apiKeyEnv}`)
      const vision = p.vision.kind === 'none'
        ? '无'
        : p.vision.kind === 'opaque'
          ? '有（取决于接入点配置）'
          : `有，限 ${p.vision.examples.join(' / ')} 等模型`
      console.log(`    视觉能力  ${vision}`)
      console.log(`    model 字段 ${p.modelFieldKind === 'endpoint_id' ? '推理接入点 ID（需自行配置）' : '模型 ID'}`)
      for (const note of p.notes) console.log(`    · ${note}`)
    }
    console.log(`\n用法：在 .env 里设 MODEL_PROVIDER 与对应的 Key，再跑 node --run models:probe`)
    return
  }

  const profile = resolveProfile(providerName)
  const apiKey = resolveApiKey(profile.apiKeyEnv)
  console.log(`供应商：${profile.label}（${profile.name}）`)
  console.log(`baseUrl：${config.modelBaseUrl ?? profile.baseUrl}`)
  console.log(`Key：${apiKey === '' ? '未设置 ✗' : `已设置（${apiKey.slice(0, 6)}…，${apiKey.length} 字符）`}`)

  if (apiKey === '') {
    console.log(`\n请设置 ${profile.apiKeyEnv}（或 MODEL_API_KEY）后重试。`)
    process.exitCode = 1
    return
  }

  if (maybeImage !== undefined && maybeImage !== '') {
    await probeVision(providerName, maybeImage)
    return
  }

  console.log(`\n── 账号可用模型 ──`)
  const models = await listModels(config.modelBaseUrl ?? profile.baseUrl, apiKey, profile.name)
  console.log(`  ${models.ok ? '✓' : '✗'} ${models.detail}`)

  console.log(`\n── 按任务逐项连通性 ──`)
  let failures = 0
  for (const task of MODEL_TASKS) {
    const outcome = await probeTask(providerName, task)
    if (!outcome.ok) failures += 1
    console.log(`  ${outcome.ok ? '✓' : '✗'} ${task.padEnd(10)} ${outcome.detail}`)
  }

  console.log(`\n${failures === 0 ? '全部通过。' : `${failures} 项未通过——按上面的提示补环境变量或换模型 ID。`}`)
  if (failures > 0) process.exitCode = 1
}

run().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
