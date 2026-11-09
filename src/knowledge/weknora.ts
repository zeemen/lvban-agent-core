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
 *
 * ⚠ 2026-11-08：上面第一条在 WeKnora v0.9.0 上**执行不了**，不是我们的 bug。
 *
 * `disable_vector_match: true` 会被后端以 HTTP 500 拒掉：
 *   ERROR: Unsupported query shape (SQLSTATE XX000)
 * 原因是 v0.9.0 给「问题生成已关闭」的文档库加了一条排除子句
 * （source_id/chunk_id 的列对列比较），ParadeDB 拒绝为它和
 * ORDER BY paradedb.score() 一起出计划 —— Tencent/WeKnora#4899，
 * 修复 PR #4908 截至今天未合并。我们两个库的 question_generation_config
 * 都是 {"enabled": false}，正好是触发条件。
 *
 * **不要用「打开问题生成」绕过。** 上游 issue 里给的就是这个 workaround，
 * 但它会往库里写模型生成的问答、而且可被检索到 —— 正是
 * weknora-data-factory#3 在挡的那种污染。宁可这一级暂时没有证据，
 * 也不能让模型写的东西混进「资料」。
 *
 * 也不要改成混合检索。那条路看着通（HTTP 200），实际是
 * retainPartialResults 把失败的关键词召回吞掉后只剩向量
 * （app 日志：`keyword=0`）—— 等于悄悄退回「永远有答案」的那一档，
 * 而第一条设计选择的全部理由就是不要它。
 *
 * 出路只有两个：把镜像钉回 v0.8.3（本设计实测通过的那一版），或等 #4908。
 * 在那之前这一级是空的，启动自检会在每次启动时报 error（readiness.ts）。
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
    // 元素不是对象就跳过。少这一行，data:[null] 会在 str() 里抛，
    // 而抛出来的位置离「这是后端回的脏数据」很远，排查要绕一圈
    if (raw === null || typeof raw !== 'object') return []
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

/** 检索地址只在这里拼：检索与启动自检共用一份，免得两处各拼一遍、迟早指向两个地方 */
export const searchUrl = (client: WeknoraClient, kbId: string): string =>
  `${client.baseUrl}/api/v1/knowledge-bases/${kbId}/hybrid-search`

/**
 * 一次检索的**整个** HTTP 请求：地址、方法、两个头、请求体、超时。
 *
 * 不只共用 buildSearchBody，是因为 2026-11-08 的第一版自检就栽在这上面：
 * 请求体共用了，外面那层各写一遍，于是自检发的是单库形状、生产发的是跨库形状，
 * 「探针探的就是生产那条路」这句话在代码里不成立而没人看得出来。
 * 让两边只能通过这一个函数发请求，那种偏离就不再写得出来。
 */
export const searchRequest = (
  client: WeknoraClient,
  input: {
    readonly query: string
    readonly kbIds: readonly string[]
    readonly timeoutMs: number
  },
): readonly [string, RequestInit] => [
  searchUrl(client, input.kbIds[0] ?? ''),
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': client.apiKey },
    body: JSON.stringify(buildSearchBody({
      query: input.query,
      limit: client.maxPassages,
      kbIds: input.kbIds,
    })),
    signal: AbortSignal.timeout(input.timeoutMs),
  },
]

/** 「K3 配好了吗」只判一处：自检的全部职责是说出生产那条路的实情，不能各有一套门槛 */
export const isConfigured = (client: WeknoraClient, kbMap: KbMap): boolean =>
  client.baseUrl !== '' && client.apiKey !== '' && Object.keys(kbMap).length > 0

const errorMessage = (body: Record<string, unknown>): string => {
  const err = body['error']
  if (typeof err === 'string') return err
  if (err !== null && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return ''
}

/**
 * 这条响应算什么 —— 本模块对线上格式的唯一判定，检索与启动自检共用一份。
 *
 * `rejected` 要盖住三种形状，它们都曾经或可能被当成「查不到」：
 *   一、非 2xx（我们那个纯 BM25 请求体在 WeKnora v0.9.0 上就是 HTTP 500）。
 *   二、**HTTP 200 但 body 里 success=false**。旧代码过了 response.ok 这道门，
 *       再因为 data 不是数组而静静返回空集 —— 故障被伪装成正常结果。
 *   三、2xx 但响应里根本没有 data 数组：我们看不懂的形状不能当空结果。
 *
 * hitCount 是后端给的条数，passages 是其中能引用的那些（空内容的会被丢掉）。
 * 两个数都要：前者说明这条通道活着，后者才是能进 prompt 的证据。
 */
export type SearchOutcome =
  | { readonly kind: 'rejected'; readonly detail: string }
  | {
    readonly kind: 'accepted'
    readonly hitCount: number
    readonly passages: readonly Passage[]
  }

export const judgeSearchResponse = (status: number, payload: unknown): SearchOutcome => {
  // Array.isArray 这一道不能省：typeof [] 也是 'object'，
  // 顶层直接给个数组的响应会从下面一路滑成「零命中」
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'rejected', detail: `检索 HTTP ${status}，响应不是对象` }
  }

  const body = payload as Record<string, unknown>
  const message = errorMessage(body)

  if (status < 200 || status >= 300 || body['success'] === false) {
    return {
      kind: 'rejected',
      detail: `检索 HTTP ${status}${message === '' ? '' : `：${message}`}`,
    }
  }
  /*
   * 零命中在线上是 data:null，不是空数组——WeKnora 的 Go 侧对
   * gorm.ErrRecordNotFound 直接 return nil, nil（2026-11-08 实测）。
   * 把它当成「看不懂的形状」会把正常的查不到误报成故障。
   */
  if (!('data' in body) || body['data'] === undefined) {
    return { kind: 'rejected', detail: `检索 HTTP ${status}，响应里没有 data 字段` }
  }
  const data = body['data']
  if (data === null) return { kind: 'accepted', hitCount: 0, passages: [] }
  if (!Array.isArray(data)) {
    return { kind: 'rejected', detail: `检索 HTTP ${status}，data 既不是数组也不是 null` }
  }
  return { kind: 'accepted', hitCount: data.length, passages: parsePassages(body) }
}

/**
 * 取 K3 证据。永不抛错、永不阻塞：没配、挂了、超时，一律当作「这次没有长尾资料」，
 * 回答照常进行。语音优先的产品里，一条引用换不来一次卡顿。
 */
export const retrievePassages = async (
  input: { readonly query: string; readonly sceneId: string | null },
  client: WeknoraClient = defaultClient(),
  kbMap: KbMap = defaultKbMap(),
): Promise<readonly Passage[]> => {
  if (!isConfigured(client, kbMap)) return []

  const kbIds = resolveKbIds(kbMap, input.sceneId)
  if (kbIds.length === 0) return []

  try {
    const response = await fetch(...searchRequest(client, {
      query: input.query, kbIds, timeoutMs: client.timeoutMs,
    }))
    const outcome = judgeSearchResponse(
      response.status,
      await response.json().catch(() => null),
    )
    /*
     * 「被拒」和「查不到」分开记。两者在产品里的表现一模一样（模型说不确定），
     * 但一个是故障、一个是正常结果。混在一起的代价 2026-11-08 付过一次：
     * K3 整条死着，日志里没有任何能和「库里确实没有」区分开的痕迹。
     */
    if (outcome.kind === 'rejected') {
      console.warn(`[k3] ${outcome.detail}，这次不带长尾证据`)
      return []
    }
    // 「回了东西但一条都引用不了」也要留痕：它和「库里确实没有」同样是空手而归，
    // 但前者说明后端或语料出了问题，而不是这个问题恰好没有资料
    if (outcome.hitCount > 0 && outcome.passages.length === 0) {
      console.warn(`[k3] 命中 ${outcome.hitCount} 条但内容都是空的，这次不带长尾证据`)
    }
    return outcome.passages.slice(0, client.maxPassages)
  } catch (error) {
    console.warn(`[k3] 检索失败，这次不带长尾证据：${(error as Error).message}`)
    return []
  }
}
