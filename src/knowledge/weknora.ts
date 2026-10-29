/**
 * K3 长尾检索 —— 规格 03 §5 证据链第三级，接在本地 WeKnora 上。
 *
 * 只取 chunk，不走它的 chat：生成留在 respond.ts。原因是受限通道（规格 03 §5.1）、
 * 口吻守卫、maxChars 这些约束都在我们这边，交出去生成就等于交出去这些约束。
 *
 * 两条设计选择来自 2026-10-29 的本地实测（WeKnora v0.8.3-152，38 个 chunk）：
 *
 * 一、关掉向量召回。向量和混合检索永远有答案——拿「量子计算机怎么编程」去问夫子庙库，
 *     向量路径照回 5 条 0.165–0.188 的 chunk。纯 BM25 回 0 条。
 *     规格 03 §5.3 要求查不到就说不确定，能说出「我没有」的只有 BM25。
 *     代价是丢了换句话问的召回，等长尾语料铺开、能量出召回率了再谈要不要补向量。
 *
 *     但这道门是漏的：同一个问题写成「量子计算机是怎么编程的？」就命中 5 条，
 *     「是」「的」「？」这些虚词足以让 BM25 不空。所以空集只是一个弱信号，
 *     真正兜住「不要编」的是 prompt 里那句「资料里没写的就说不确定」——
 *     实测问量子编程时模型确实说了不确定，靠的是它，不是空集。
 *
 * 二、不用它的分数做门槛。只要 BM25 有任意命中，top-1 就被归一到 1.0——
 *     拿「今天停车场在哪」去问，top-1 也是 1.0；vector_threshold 和 keyword_threshold
 *     都拦不住。分数只用来排序，是否可引用由 must_cite 回查决定（规格 03 §5.1）。
 */

const SEARCH_TIMEOUT_DEFAULT_MS = 800

export type Passage = {
  readonly chunkId: string
  readonly knowledgeId: string
  readonly title: string
  readonly text: string
  readonly score: number
}

export type WeknoraClient = {
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxPassages: number
}

/** 场景 → 知识库 ID */
export type KbMap = Readonly<Record<string, string>>

export type SearchBody = {
  readonly query_text: string
  readonly match_count: number
  readonly disable_vector_match: true
  readonly skip_context_enrichment: true
  readonly knowledge_base_ids?: readonly string[]
}

export const buildSearchBody = (input: {
  readonly query: string
  readonly limit: number
  readonly kbIds: readonly string[]
}): SearchBody => ({
  query_text: input.query,
  match_count: input.limit,
  disable_vector_match: true,
  skip_context_enrichment: true,
  // 单库时路径里的 id 已经说明了一切，多带一个字段只会多一处可能对不上的地方
  ...(input.kbIds.length > 1 ? { knowledge_base_ids: input.kbIds } : {}),
})

type RawHit = {
  readonly id?: unknown
  readonly content?: unknown
  readonly knowledge_id?: unknown
  readonly knowledge_title?: unknown
  readonly score?: unknown
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 解析响应。形状不认识时返回空数组而不是抛错：
 * 这一层的失败只应该让回答少一条引用，不应该让用户听不到话。
 */
export const parsePassages = (payload: unknown): readonly Passage[] => {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []

  return data.flatMap((raw: RawHit): readonly Passage[] => {
    const text = str(raw.content).trim()
    if (text === '') return []
    const knowledgeId = str(raw.knowledge_id)
    return [{
      chunkId: str(raw.id),
      knowledgeId,
      // 标题缺了就退回文档 ID：引用里留一个空白来源比留一个丑 ID 更糟
      title: str(raw.knowledge_title) === '' ? knowledgeId : str(raw.knowledge_title),
      text,
      score: typeof raw.score === 'number' ? raw.score : 0,
    }]
  })
}

/** 解析 "fuzimiao=xxx,njmuseum=yyy"；半截的项一律丢掉，别让它变成假库 ID */
export const parseKbMap = (raw: string): KbMap =>
  Object.fromEntries(
    raw.split(',')
      .map((pair) => pair.split('=').map((s) => s.trim()))
      .filter((parts): parts is [string, string] =>
        parts.length === 2 && parts[0] !== '' && parts[1] !== ''),
  )

/** 知道在哪个场景就只搜那个库；不知道就全搜——用户站在哪不该决定他能不能问 */
export const resolveKbIds = (map: KbMap, sceneId: string | null): readonly string[] => {
  const scoped = sceneId === null ? undefined : map[sceneId]
  return scoped === undefined ? Object.values(map) : [scoped]
}

export const defaultClient = (env: NodeJS.ProcessEnv = process.env): WeknoraClient => ({
  baseUrl: env.WEKNORA_BASE_URL ?? '',
  apiKey: env.WEKNORA_API_KEY ?? '',
  timeoutMs: Number(env.WEKNORA_TIMEOUT_MS ?? String(SEARCH_TIMEOUT_DEFAULT_MS)),
  maxPassages: Number(env.WEKNORA_MAX_PASSAGES ?? '3'),
})

export const defaultKbMap = (env: NodeJS.ProcessEnv = process.env): KbMap =>
  parseKbMap(env.WEKNORA_KB_IDS ?? '')

/**
 * 取 K3 证据。永不抛错、永不阻塞：没配、挂了、超时，一律当作「这次没有长尾资料」，
 * 回答照常进行。语音优先的产品里，一条引用换不来一次卡顿。
 */
export const retrievePassages = async (
  input: { readonly query: string; readonly sceneId: string | null },
  client: WeknoraClient = defaultClient(),
  kbMap: KbMap = defaultKbMap(),
): Promise<readonly Passage[]> => {
  if (client.baseUrl === '' || client.apiKey === '') return []

  const kbIds = resolveKbIds(kbMap, input.sceneId)
  if (kbIds.length === 0) return []

  const body = buildSearchBody({ query: input.query, limit: client.maxPassages, kbIds })

  try {
    const response = await fetch(
      `${client.baseUrl}/api/v1/knowledge-bases/${kbIds[0]}/hybrid-search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': client.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(client.timeoutMs),
      },
    )
    if (!response.ok) {
      console.warn(`[k3] 检索 HTTP ${response.status}，这次不带长尾证据`)
      return []
    }
    return parsePassages(await response.json()).slice(0, client.maxPassages)
  } catch (error) {
    console.warn(`[k3] 检索失败，这次不带长尾证据：${(error as Error).message}`)
    return []
  }
}
