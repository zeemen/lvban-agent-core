import {
  isConfigured, judgeSearchResponse, resolveKbIds, searchRequest,
  type KbMap, type WeknoraClient,
} from './weknora.js'

/**
 * K3 启动自检 —— 「查不到」和「这条链路坏了」在产品里长得一模一样，必须有人把它们分开。
 *
 * 2026-11-08 实测：K3 整条是死的，而仓库里没有任何东西会说出来。
 *   一、`.env` 指的 8080 已经没人应答——容器映射漂到了 8180。
 *   二、换到活的端口之后，`disable_vector_match: true` 这个请求被后端以
 *       HTTP 500 拒掉（Tencent/WeKnora#4899，v0.9.0 的回归，修复 PR #4908 未合并）。
 *
 * 为什么 863 条用例全绿也照不出来：所有 WeKnora 用例都 mock 掉了 fetch，
 * 没有一条用真实请求体打过真实后端。而 retrievePassages 的降级是刻意的
 * （语音产品不能为一条引用卡顿），所以线上表现就是「模型忽然什么都不知道了」。
 *
 * 判据刻意不是「后端活着吗」。那天后端活着：去掉 disable_vector_match 就回 200。
 * 判据是「**生产实际发的那些请求**都被接受了吗」——注意是复数，见 probeTargets。
 * 为了让这句话在代码里真的成立，请求整个由 weknora.ts 的 searchRequest 发出：
 * 自检不自己拼请求，于是也就偏离不了。
 */

/**
 * 探针词 —— 逐个试，试到有结论为止。
 *
 * 为什么不能只用一个：坏掉的 BM25 只在「这个词在这个库里真有候选」时才报 500；
 * 一个字都不沾时 Postgres 直接短路，回 200 + data:null。2026-11-08 实测，
 * 拿「明远楼」探南博库得到的是一个看着正常的 empty，而那个库的 BM25 同样是坏的
 * （换成「竹林七贤」立刻 500）。一个探针词等于给每个不含该词的库开一张免检通行证。
 *
 * 所以每个场景各放一个一定在自己语料里的专名。新增场景时在这里补一个，
 * 否则那个库的自检只能得到「没能证明」。
 */
export const PROBE_QUERIES: readonly string[] = ['明远楼', '竹林七贤']

/**
 * 探测用的超时。
 *
 * 下限：检索那边是 800ms，刻意的——语音优先，宁可少一条引用也不卡住这句话。
 * 但自检要的是**真正的原因**：2026-11-08 实测，坏掉的后端花了约 2 秒才把那个 500
 * 送回来。沿用 800ms 的第一版自检在知道原因之前就超时，于是把「请求体被拒」
 * 误报成「连不上」，提示还去指端口——而端口那会儿已经是对的。
 *
 * 上限：第一版只有下限，于是把别人配的长超时原样放大。诊断的全部价值在于被看见，
 * 让那条谁都需要的 error 晚几分钟才出现，等于没有。
 */
const PROBE_TIMEOUT_FLOOR_MS = 5_000
const PROBE_TIMEOUT_CEILING_MS = 10_000

export const probeTimeoutMs = (clientTimeoutMs: number): number => {
  // 配成非数字时退回下限：NaN 会被 AbortSignal.timeout 当成 0，
  // 于是每次探测瞬间 abort，报出来的又是「连不上」——还是归错因
  if (!Number.isFinite(clientTimeoutMs)) return PROBE_TIMEOUT_FLOOR_MS
  return Math.min(Math.max(clientTimeoutMs, PROBE_TIMEOUT_FLOOR_MS), PROBE_TIMEOUT_CEILING_MS)
}

export type ProbeTarget = {
  readonly label: string
  readonly kbIds: readonly string[]
}

/**
 * 要探哪些请求形状 —— 生产会发的那些，一个不少。
 *
 * 生产的 sceneId 来自锚点：`anchor?.sceneId ?? null`（respond.ts）。于是有两种形状：
 *   站在点位上问 → sceneId 有值 → 单库，路径里一个 id，不带 knowledge_base_ids。
 *   随口问一句   → sceneId 为 null → resolveKbIds 返回整张表 → 跨库，多带一个字段。
 * 后者还更常见。
 *
 * 第一版自检只探前者：它拿 `{ [sceneId]: kbId }` 这样一张单条目表去 resolveKbIds，
 * 结果恒等于 [kbId]。而 #4899 是**查询计划**被拒，多一个跨库过滤条件恰恰是
 * 可能被另行规划的那种变化——自检报「可检索」，而最常见的那个请求从没被试过。
 *
 * 只有一个库时跨库形状与单库形状本来相同，不重复探。
 */
export const probeTargets = (kbMap: KbMap): readonly ProbeTarget[] => {
  const scenes = Object.keys(kbMap)
  const perScene = scenes.map((sceneId) => ({
    label: sceneId,
    kbIds: resolveKbIds(kbMap, sceneId),
  }))
  if (scenes.length < 2) return perScene
  return [...perScene, { label: '无锚点（跨库）', kbIds: resolveKbIds(kbMap, null) }]
}

export type ProbeState = 'ok' | 'empty' | 'unreachable' | 'rejected'

export type K3Probe = {
  readonly label: string
  readonly kbIds: readonly string[]
  readonly state: ProbeState
  readonly detail: string
}

export type K3Readiness = {
  readonly configured: boolean
  readonly baseUrl: string
  readonly probes: readonly K3Probe[]
}

/**
 * 纯判定：这一次探测算什么。
 *
 * 判线上响应形状的那条规则**不在这里**——它在 weknora.ts 的 judgeSearchResponse，
 * 检索和自检共用同一份。各判一次迟早漂成两套：自检说好、检索说坏，
 * 或者反过来，而现场只会更难查。这里只做一件事：把那个判定翻成探针的词。
 */
export const classifyProbe = (
  status: number,
  payload: unknown,
): { readonly state: ProbeState; readonly detail: string } => {
  const outcome = judgeSearchResponse(status, payload)
  if (outcome.kind === 'rejected') return { state: 'rejected', detail: outcome.detail }
  if (outcome.hitCount === 0) return { state: 'empty', detail: '这个词一条没中' }
  // 通道通着，证据却是空的：报 ok 会让人以为这一级在干活，
  // 报「没中」又抹掉了「后端确实回了东西」。它自己是一档
  if (outcome.passages.length === 0) {
    return { state: 'empty', detail: `命中 ${outcome.hitCount} 条但一条都不可引用（内容为空）` }
  }
  return { state: 'ok', detail: `命中 ${outcome.hitCount} 条` }
}

const probeWithQuery = async (
  client: WeknoraClient,
  target: ProbeTarget,
  query: string,
): Promise<{ readonly state: ProbeState; readonly detail: string }> => {
  /*
   * 只有 fetch 本身包在 try 里。判定放在外面是刻意的：
   * 一旦把解析也圈进来，我们自己的解析 bug 会被这个 catch 说成「连不上」，
   * 而那条提示让人去查端口和 docker ps——后端其实好好地在应答。
   * 归错因正是这个文件要防的东西，所以不留这条缝；真有解析异常，
   * 让它冒到 server.ts 的「核对失败」去，那句话说的是实话。
   */
  let response: Response
  try {
    response = await fetch(...searchRequest(client, {
      query, kbIds: target.kbIds, timeoutMs: probeTimeoutMs(client.timeoutMs),
    }))
  } catch (error) {
    return { state: 'unreachable', detail: (error as Error).message }
  }
  return classifyProbe(response.status, await response.json().catch(() => null))
}

/** empty 是唯一「还没有结论」的状态：换个词再试一次有意义，其余三个都已经定了 */
const probeTarget = async (
  client: WeknoraClient,
  target: ProbeTarget,
): Promise<K3Probe> => {
  for (const query of PROBE_QUERIES) {
    const outcome = await probeWithQuery(client, target, query)
    if (outcome.state !== 'empty') return { ...target, ...outcome }
  }
  return {
    ...target,
    state: 'empty',
    detail: PROBE_QUERIES.length === 0
      ? '一个探针词都没配'
      : `探针词（${PROBE_QUERIES.join('、')}）一个都没中`,
  }
}

export const checkK3Readiness = async (
  client: WeknoraClient,
  kbMap: KbMap,
): Promise<K3Readiness> => {
  if (!isConfigured(client, kbMap)) {
    return { configured: false, baseUrl: client.baseUrl, probes: [] }
  }
  /*
   * 各形状之间并行，形状内部的换词仍然串行（那是刻意的提前退出）。
   * 串行跑完所有形状的那一版，最坏情况是「形状数 × 词数 × 超时」——
   * 一个要等上几分钟才出现的诊断没人会看见。
   */
  const probes = await Promise.all(
    probeTargets(kbMap).map((target) => probeTarget(client, target)),
  )
  return { configured: true, baseUrl: client.baseUrl, probes }
}

export type ReadinessReport = {
  readonly level: 'info' | 'warn' | 'error'
  readonly lines: readonly string[]
}

const HINTS: Readonly<Record<'unreachable' | 'rejected', string>> = {
  unreachable:
    '  连不上。核对 WEKNORA_BASE_URL 与容器实际映射的端口（docker ps 看 ->8080/tcp 映到了哪）。',
  rejected:
    '  后端拒了我们的请求体。若报 Unsupported query shape，就是 Tencent/WeKnora#4899：\n'
    + '    v0.9.0 起，问题生成关闭的文档库走 disable_vector_match 必失败（修复 PR #4908 未合并）。\n'
    + '    不要用「打开问题生成」绕过——那会往库里写模型生成的问答并可被检索到，\n'
    + '    正是 weknora-data-factory#3 要挡的污染。把镜像钉回 v0.8.3，或等上游。',
}

/** 纯函数：把核对结果写成人话。最多列 5 条，剩下的报个数 —— 启动日志不是清单 */
export const k3Report = (r: K3Readiness): ReadinessReport => {
  if (!r.configured) {
    return { level: 'info', lines: ['K3 长尾检索未配置，自由问答只用锚点与记忆作证据。'] }
  }

  const count = (s: ProbeState): number => r.probes.filter((p) => p.state === s).length
  const broken = r.probes.filter((p) => p.state === 'rejected' || p.state === 'unreachable')
  const head = `K3 长尾检索 ${count('ok') + count('empty')}/${r.probes.length} 个请求形状可用（${r.baseUrl}）`

  if (broken.length === 0 && count('empty') === 0) return { level: 'info', lines: [head] }

  const sample = (ps: readonly K3Probe[]): readonly string[] => [
    ...ps.slice(0, 5).map((p) => `    ${p.label}（${p.kbIds.join('、')}）：${p.detail}`),
    ...(ps.length > 5 ? [`    …另有 ${ps.length - 5} 个`] : []),
  ]

  if (broken.length === 0) {
    return {
      level: 'warn',
      lines: [head, `  ${count('empty')} 个形状没能证明可用（探针词一个都没中，BM25 那条路没被真的执行到）：`,
        ...sample(r.probes.filter((p) => p.state === 'empty'))],
    }
  }

  const kinds = new Set(broken.map((p) => p.state))
  return {
    level: 'error',
    lines: [
      head,
      `  ${broken.length} 个形状取不到证据（自由问答会静静退化成「我不确定」）：`,
      ...sample(broken),
      ...(kinds.has('unreachable') ? [HINTS.unreachable] : []),
      ...(kinds.has('rejected') ? [HINTS.rejected] : []),
    ],
  }
}
