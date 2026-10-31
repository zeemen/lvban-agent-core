import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * K3 语料的房式格式解析 —— 运营后台「知识管理」的底座（规格 04 §274）。
 *
 * 这 14 篇是手写的 markdown，字段靠「键：值」行约定，没有 frontmatter。
 * 解析一律宽容：缺字段留空，不抛错。这个解析器服务的是一块「看出谁缺什么」
 * 的面板，一篇写坏了就让它在面板上显示成缺字段，不该连带整页打不开。
 */

const CONTENT_DIR = join(import.meta.dirname, '..', '..', 'content', 'knowledge')

/** 摘要末尾那句固定免责，不算内容 */
const BOILERPLATE = /本摘要不是对关联锚点全部事实的完整覆盖。|本条仅限展馆概述[^\n]*/g

export type KbDoc = {
  /** 相对 content/knowledge 的路径，面板上用它定位文件 */
  readonly file: string
  readonly title: string
  readonly knowledgeId: string
  readonly sceneId: string
  readonly anchors: readonly string[]
  readonly keywords: readonly string[]
  readonly sourceUrl: string
  readonly locator: string
  readonly checkedAt: string
  readonly publishedAt: string
  readonly reviewStatus: string
  readonly summary: string
}

export type KbGap =
  | 'missing_source'
  | 'missing_locator'
  | 'unreviewed'
  | 'scene_mismatch'
  | 'stale_check'
  /** 关联锚点写的不是规格 04 §4.1 的 id 格式，连指的是什么都看不出来 */
  | 'anchor_placeholder'
  /** 格式对，但那个锚点还没建 —— 是 M1 的进度，不是写错了 */
  | 'anchor_missing'

/** 「键：值」取值；中英文冒号都认，手写内容里两种都出现过 */
const field = (text: string, key: string): string => {
  const hit = new RegExp(`^${key}[：:]\\s*(.+)$`, 'm').exec(text)
  return hit?.[1]?.trim() ?? ''
}

/** 顿号／逗号分隔的列表；「未记录」这种占位当作空 */
const list = (value: string): readonly string[] =>
  value === '' || value === '未记录'
    ? []
    : value.split(/[、,，]/).map((s) => s.trim()).filter((s) => s !== '')

export const parseKbDoc = (text: string, file: string): KbDoc => {
  const summaryBlock = /##\s*资料摘要与适用边界\s*([\s\S]*?)(?=\n##\s|$)/.exec(text)?.[1] ?? ''
  return {
    file,
    title: (/^#\s+(.+)$/m.exec(text)?.[1] ?? '').trim(),
    knowledgeId: field(text, '知识ID'),
    sceneId: field(text, '场景'),
    anchors: list(field(text, '关联锚点')),
    keywords: list(field(text, '关键词')),
    sourceUrl: field(text, '来源'),
    locator: field(text, '原文定位'),
    checkedAt: field(text, '核对日期'),
    publishedAt: field(text, '资料发布日期'),
    reviewStatus: field(text, '审核状态'),
    summary: summaryBlock.replace(BOILERPLATE, '').trim(),
  }
}

/** 核对日期超过这个天数就提醒重核一遍。来源页会改，链接会烂 */
const STALE_DAYS = 180

/** 锚点 ID 编号规则（规格 04 §4.1）：njm_<slug> 南博、fzm_<slug> 夫子庙 */
const ANCHOR_ID = /^(njm|fzm)_[a-z0-9_]+$/

const daysSince = (iso: string, now: Date): number | null => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 86_400_000)
}

/** 锚点侧实际有的词表。两边摆在一起比，才看得见语料指向了不存在的东西 */
export type KnownVocabulary = {
  /** 锚点里实际用的场景词 */
  readonly scenes: readonly string[]
  /** 已经建好锚点文件的 anchorId */
  readonly anchors: readonly string[]
}

/**
 * 这一篇缺什么。
 *
 * 场景词和关联锚点这两类缺陷都只能靠对照锚点侧才发现：文档写「场景：museum」
 * 而锚点写 nanjing_museum、关联锚点写 fuzimiao-3 而锚点叫 fzm_mingyuan_lou，
 * 单看语料文件本身都像是填好了的。
 *
 * 关联锚点分两档，因为该做的事不一样：格式不对是写错了，改语料；
 * 格式对但锚点没建是 M1 的进度，补锚点。混成一条就分不清该找谁。
 */
export const findGaps = (
  doc: KbDoc, known: KnownVocabulary, now: Date = new Date(),
): readonly KbGap[] => {
  const gaps: KbGap[] = []
  if (doc.sourceUrl === '') gaps.push('missing_source')
  if (doc.locator === '' || /待补|待定|TODO|TBD/i.test(doc.locator)) gaps.push('missing_locator')
  if (doc.reviewStatus === '' || /待复核|待审|draft/i.test(doc.reviewStatus)) gaps.push('unreviewed')
  /*
   * 词表空了就不比。锚点一个都没加载出来时，拿空词表比会把每一篇都判成
   * 场景词不对——17 条错误里没有一条是真的，只会盖住别的问题。
   */
  if (doc.sceneId !== '' && known.scenes.length > 0 && !known.scenes.includes(doc.sceneId)) {
    gaps.push('scene_mismatch')
  }
  // 一行里混着好的和占位的也要报，所以这里看的是「有没有」而不是「是不是全是」
  if (doc.anchors.some((id) => !ANCHOR_ID.test(id))) gaps.push('anchor_placeholder')
  if (doc.anchors.some((id) => ANCHOR_ID.test(id) && !known.anchors.includes(id))) {
    gaps.push('anchor_missing')
  }
  const age = daysSince(doc.checkedAt, now)
  if (age !== null && age > STALE_DAYS) gaps.push('stale_check')
  return gaps
}

/** 读 content/knowledge/<场景>/<名>.md 全部语料 */
export const loadKbDocs = async (dir: string = CONTENT_DIR): Promise<readonly KbDoc[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => join(e.parentPath, e.name))

  return Promise.all(files.map(async (path) =>
    parseKbDoc(await readFile(path, 'utf8'), path.slice(dir.length + 1))))
}
