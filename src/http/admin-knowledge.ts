import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { loadAnchors } from '../content/loader.js'
import { findGaps, loadKbDocs, type KbDoc, type KbGap } from '../content/kb-docs.js'
import { checkSource } from '../content/source-check.js'
import { defaultClient, defaultKbMap } from '../knowledge/weknora.js'

/**
 * 运营后台 · 知识管理（规格 04 §48、§274）。
 *
 * 只做本次会话里被证明最费人工的两段：
 *   · 采集核验——抓回来源页，逐句确认要引用的话真的在里面
 *   · 维护面板——14 篇的现状摆在一起：谁缺原文定位、谁的来源打不开、
 *     谁还是「迁移待复核」、谁的场景词和锚点对不上
 *
 * 不做建设/编辑的写回：往 WeKnora 写要 ingest 权限，那是一次提权，
 * 应该由人在知道自己在干什么的时候点，不该藏在一个默认开着的页面后面。
 *
 * **默认关闭。** 没有 ADMIN_TOOLS=true 就一条路由都不注册：
 * 这里能按任意地址发请求、能读仓库内容，不该跟着业务服务一起上线。
 */

const verifySchema = z.object({
  url: z.string().min(1),
  claims: z.array(z.string()).min(1).max(20),
})

export const adminToolsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ADMIN_TOOLS === 'true'

export type DocRow = KbDoc & {
  readonly gaps: readonly KbGap[]
  /** WeKnora 里这篇的解析状态；取不到就是 null（库没配或没跑） */
  readonly weknora: { readonly parseStatus: string; readonly chunks: number } | null
}

type RawKnowledge = { file_name?: unknown; parse_status?: unknown }

/** 问 WeKnora 每个库里都有哪些文档，用文件名对上仓库里的篇目 */
const weknoraIndex = async (): Promise<ReadonlyMap<string, string>> => {
  const client = defaultClient()
  const kbIds = Object.values(defaultKbMap())
  const index = new Map<string, string>()
  if (client.baseUrl === '' || client.apiKey === '' || kbIds.length === 0) return index

  await Promise.all(kbIds.map(async (kbId) => {
    try {
      const response = await fetch(
        `${client.baseUrl}/api/v1/knowledge-bases/${kbId}/knowledge?page=1&page_size=200`,
        { headers: { 'X-API-Key': client.apiKey }, signal: AbortSignal.timeout(5000) },
      )
      if (!response.ok) return
      const payload = await response.json() as { data?: unknown }
      const rows = Array.isArray(payload.data) ? payload.data : []
      for (const raw of rows as RawKnowledge[]) {
        if (typeof raw.file_name === 'string') {
          index.set(raw.file_name, typeof raw.parse_status === 'string' ? raw.parse_status : '?')
        }
      }
    } catch {
      // 面板少一列状态，不该让整页打不开
    }
  }))
  return index
}

export const buildDocRows = async (): Promise<readonly DocRow[]> => {
  const [docs, anchors, wk] = await Promise.all([loadKbDocs(), loadAnchors(), weknoraIndex()])
  const known = {
    scenes: [...new Set([...anchors.values()].map((a) => a.sceneId))],
    // 两套 id 都算（见 content/lint.ts 的 knownAnchorIds）：面板和门禁得同口径，
    // 否则面板说「锚点还没建」而 lint 说没事，内容负责人不知道信哪个
    anchors: [...new Set([
      ...anchors.keys(),
      ...[...anchors.values()].flatMap((a) => [a.poiId, a.exhibitId].filter(
        (id): id is string => id !== undefined,
      )),
    ])],
  }

  return docs.map((doc): DocRow => {
    const base = doc.file.split('/').pop() ?? doc.file
    const status = wk.get(base)
    return {
      ...doc,
      gaps: findGaps(doc, known),
      weknora: status === undefined ? null : { parseStatus: status, chunks: 0 },
    }
  })
}

/** 按房式格式拼一篇草稿。字段顺序和现有 14 篇完全一致，省得入库后 diff 乱跳 */
export const renderDraft = (input: {
  readonly title: string; readonly knowledgeId: string; readonly sceneId: string
  readonly anchors: string; readonly keywords: string; readonly sourceUrl: string
  readonly locator: string; readonly checkedAt: string; readonly publishedAt: string
  readonly reviewStatus: string; readonly summary: string
}): string =>
  `# ${input.title}\n\n`
  + `知识ID：${input.knowledgeId}\n`
  + `场景：${input.sceneId}\n`
  + `关联锚点：${input.anchors}\n`
  + `关键词：${input.keywords}\n\n`
  + `## 来源与核对\n\n`
  + `来源：${input.sourceUrl}\n`
  + `原文定位：${input.locator}\n`
  + `核对日期：${input.checkedAt}\n`
  + `资料发布日期：${input.publishedAt}\n`
  + `审核状态：${input.reviewStatus}\n\n`
  + `## 资料摘要与适用边界\n\n`
  + `${input.summary}\n\n`
  + `本摘要不是对关联锚点全部事实的完整覆盖。\n`

export const registerAdminKnowledgeRoutes = (app: FastifyInstance, html: string): void => {
  if (!adminToolsEnabled()) return

  app.get('/admin/knowledge', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(html))

  app.get('/v1/admin/kb/docs', async () => ({ docs: await buildDocRows() }))

  app.post('/v1/admin/kb/verify', async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues })
    }
    return checkSource(parsed.data)
  })

  app.post('/v1/admin/kb/draft', async (request) => ({
    markdown: renderDraft(request.body as Parameters<typeof renderDraft>[0]),
  }))
}
