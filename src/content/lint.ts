import { pathToFileURL } from 'node:url'
import type { PlanDecision } from '../planner/decide.js'
import { checkRegister, hasHedgeMarker } from '../planner/register-guard.js'
import { renderFromAnchor } from '../planner/render.js'
import { findGaps, loadKbDocs } from './kb-docs.js'
import { anchorForPlace, loadAnchors, type Anchor } from './loader.js'

/**
 * 内容静态检查 —— 把规格 03 §9.1 的「口吻一致性」与「三类表述分离」
 * 从运行时告警提前到录入时拦截。
 *
 * 为什么必须在这里拦：锚点是人工精调内容，口吻问题是内容缺陷而不是运行时缺陷。
 * 等到现场用户听见了才在日志里告警，就太晚了。
 *
 * **这个检查不碰数据库、Redis、WeKnora，也不读任何密钥**，而且要一直如此。
 * 锚点与语料都是磁盘上的文件，renderFromAnchor / checkRegister / findGaps
 * 全是纯函数。中台按 git PR 交付（content/supply-chain-contract.md），
 * 门禁必须能在一个没有 .env、没有任何服务的 CI runner 上跑起来。
 *
 * 原先这里 import 了 db/pool 与 db/redis，只为在收尾时关掉两个从没打开过的
 * 连接；而 import 它们就会 import config，config 缺 DATABASE_URL 时直接抛错——
 * 于是整个门禁在 CI 上连一行内容都还没看就先崩了。别再把它们加回来。
 */

export type Finding = {
  readonly anchorId: string
  readonly severity: 'error' | 'warn'
  readonly rule: string
  readonly detail: string
}

/**
 * 枚举 Planner 能产生的渲染路径。
 *
 * 直接调用运行时的 renderFromAnchor，而不是在 lint 里手写一遍拼接顺序——
 * 否则 lint 和运行时会漂移，重访路径这种分支就会成为盲区。
 */
const renderPaths = (): readonly { readonly label: string; readonly decision: PlanDecision }[] => {
  const base: PlanDecision = {
    shouldSpeak: true, length: 'long', register: 'peer', openWith: 'question',
    useStory: true, linkCurriculum: false, linkMemory: null, leaveHook: true,
    skipMainExplanation: false, nextAction: null, evidenceRequired: [],
    maxTokens: 220, maxChars: 220, reason: 'lint',
  }
  return [
    { label: '同游·首访·提问开场', decision: base },
    { label: '同游·首访·观察开场', decision: { ...base, openWith: 'observation' } },
    {
      label: '同游·重访·记忆开场',
      decision: {
        ...base, openWith: 'memory_link', linkMemory: '南京·某地·科举',
        skipMainExplanation: true,
      },
    },
    { label: '亲子·首访', decision: { ...base, register: 'storyteller' } },
    {
      label: '轻导览',
      decision: { ...base, register: 'concise', openWith: 'fact', length: 'short', useStory: false },
    },
    { label: '同游·疲劳·短讲', decision: { ...base, length: 'short', leaveHook: false } },
  ]
}

/** must_cite 六类字段：出现这些信息就必须有 K1 来源（规格 03 §5.1） */
const MUST_CITE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '年代', pattern: /\d{2,4}\s*年|公元|世纪|朝(初|末)|[战汉唐宋元明清]代/ },
  { label: '尺寸', pattern: /\d+\s*(厘米|cm|米|毫米|公斤|克|斤)/ },
  { label: '出土地点', pattern: /出土于|发现于|出自.{2,8}(墓|遗址)/ },
]

export const lintAnchor = (
  anchor: Anchor, anchors: ReadonlyMap<string, Anchor>,
): readonly Finding[] => {
  const findings: Finding[] = []
  const e = anchor.elements

  for (const { label, decision } of renderPaths()) {
    const rendered = renderFromAnchor(anchor, decision)
    if (rendered.text === '') continue

    const guard = checkRegister(rendered.text, decision.register)
    for (const violation of guard.violations) {
      findings.push({
        anchorId: anchor.anchorId,
        severity: 'error',
        rule: `register/${violation.rule}`,
        detail: `${label}：「${violation.matched}」（要素 ${rendered.usedElements.join('+')}）`,
      })
    }
  }

  // Evidence-first：有 must_cite 信息但没有 K1 来源
  const allText = JSON.stringify(e)
  for (const { label, pattern } of MUST_CITE_PATTERNS) {
    const hit = pattern.exec(allText)
    if (hit !== null && anchor.k1Sources.length === 0) {
      findings.push({
        anchorId: anchor.anchorId,
        severity: 'error',
        rule: 'evidence/missing_k1',
        detail: `出现 ${label} 信息「${hit[0]}」但 k1Sources 为空（规格 03 §5.1）`,
      })
    }
  }

  // 学术解释须带标记
  const explanation = e.explanation.companion ?? ''
  if (/工艺|做法|技法|制法/.test(explanation) && !hasHedgeMarker(explanation)) {
    findings.push({
      anchorId: anchor.anchorId,
      severity: 'warn',
      rule: 'evidence/unmarked_interpretation',
      detail: '讲解涉及工艺做法但未使用「一种说法是 / 学界普遍认为」等标记（规格 03 §5.2）',
    })
  }

  // 占位文本不能流到用户端
  const PLACEHOLDER = /待补|待定|待核定|待审校|待补充|待实测|待内容|TODO|TBD|占位|xxx/i
  for (const [key, value] of Object.entries(e)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const hit = PLACEHOLDER.exec(text)
    if (hit !== null) {
      findings.push({
        anchorId: anchor.anchorId,
        severity: 'error',
        rule: 'content/placeholder',
        detail: `要素 ${key} 含占位文本「${hit[0]}」，会被直接念给用户`,
      })
    }
  }

  /*
   * nextAction 指的下一站得真的存在。
   *
   * 只报警告，不报错误：decision.nextAction 今天算出来之后没有任何消费方
   * （见 README「维护面板与计划里的死字段」），指错了也到不了用户，还不到
   * 「静默地少讲」那一档。但这一栏迟早要接上，接上之前就该是干净的——
   * 号舍锚点指着 fzm_mingyuan_lou 指了一天多，谁都没发现。
   *
   * 两套 id 都认：规格 04 §4.5 的例子里，锚点 fzm_jiangnan_gongyuan_haoshe
   * 指的是点位 id fzm_mingyuan_lou，所以这一栏写锚点 id 或点位 id 都算对。
   */
  const suggest = e.nextAction.suggest
  if (suggest !== null && !anchors.has(suggest) && anchorForPlace(anchors, suggest) === null) {
    findings.push({
      anchorId: anchor.anchorId,
      severity: 'warn',
      rule: 'next_action/dangling',
      detail: `nextAction 指向「${suggest}」，但它既不是锚点 id 也不是任何锚点的点位 id`,
    })
  }

  // 上线门槛
  if (anchor.isTop30 && anchor.review.status !== 'approved') {
    findings.push({
      anchorId: anchor.anchorId,
      severity: 'warn',
      rule: 'review/not_approved',
      detail: `Top30 锚点审校状态=${anchor.review.status}，待核 ${anchor.review.factCheckRequired.length} 条（规格 03 §9.2 要求双签）`,
    })
  }

  return findings
}

/**
 * 语料「关联锚点」那一栏认两套 id。
 *
 * 应答路径靠 anchorForPlace 反查，它比的是 poiId / exhibitId；而 anchorId
 * 是另一套（号舍锚点的 id 是 fzm_jiangnan_gongyuan_haoshe，点位 id 是
 * fzm_jiangnan_gongyuan）。只收 anchorId 的话，kb-gongyuan 写的
 * fzm_jiangnan_gongyuan 明明取得到锚点，却被判成「锚点还没建」——
 * 让内容负责人去补一个已经有的东西，是比漏报更费时间的误报。
 */
export const knownAnchorIds = (anchors: ReadonlyMap<string, Anchor>): readonly string[] => [
  ...new Set([
    ...anchors.keys(),
    ...[...anchors.values()].flatMap((a) => [a.poiId, a.exhibitId].filter(
      (id): id is string => id !== undefined,
    )),
  ]),
]

/**
 * K3 语料侧只查关联锚点这一栏，不把面板上的缺口全搬过来。
 *
 * 分界线是「会不会静默地少讲」：关联锚点指不到东西，应答路径就取不到锚点，
 * K1 和八要素到不了用户，而面板上这一篇看着是填好了的——必须拦。
 * 缺原文定位、待双签这些是内容负责人的待办清单，面板上看就够了，
 * 搬进门禁只会让 17 条警告盖住真正该拦的那一条。
 */
const lintKbDocs = async (anchors: ReadonlyMap<string, Anchor>): Promise<readonly Finding[]> => {
  const docs = await loadKbDocs()
  const known = {
    scenes: [...new Set([...anchors.values()].map((a) => a.sceneId))],
    anchors: knownAnchorIds(anchors),
  }

  return docs.flatMap((doc): readonly Finding[] => {
    const gaps = findGaps(doc, known)
    const findings: Finding[] = []
    if (gaps.includes('scene_mismatch')) {
      findings.push({
        anchorId: doc.file,
        severity: 'error',
        rule: 'scene/unknown',
        detail: `场景「${doc.sceneId}」不在锚点用的词表里（${known.scenes.join('、')}）`
          + '，文件自己躺在哪个目录都对不上',
      })
    }
    if (gaps.includes('anchor_placeholder')) {
      findings.push({
        anchorId: doc.file,
        severity: 'error',
        rule: 'anchor/placeholder',
        detail: `关联锚点「${doc.anchors.join('、')}」不是 njm_/fzm_ 格式的 id`
          + '（规格 04 §4.1），应答路径按它取不到锚点',
      })
    }
    if (gaps.includes('anchor_missing')) {
      findings.push({
        anchorId: doc.file,
        severity: 'warn',
        rule: 'anchor/not_built',
        detail: `关联锚点 ${doc.anchors.filter((a) => !known.anchors.includes(a)).join('、')}`
          + ' 还没有锚点文件（M1 门槛 30 个，现有 ' + String(anchors.size) + ' 个）',
      })
    }
    return findings
  })
}

const run = async (): Promise<void> => {
  const anchors = await loadAnchors()
  const docs = await loadKbDocs()
  const findings = [
    // 不能直接 flatMap(lintAnchor)：flatMap 的第二个实参是下标，会当成词表传进去
    ...[...anchors.values()].flatMap((a) => lintAnchor(a, anchors)),
    ...await lintKbDocs(anchors),
  ]

  const errors = findings.filter((f) => f.severity === 'error')
  const warns = findings.filter((f) => f.severity === 'warn')

  console.log(`[lint:content] 检查 ${anchors.size} 个锚点、${docs.length} 篇语料`)
  for (const f of findings) {
    const mark = f.severity === 'error' ? '✗' : '!'
    console.log(`  ${mark} [${f.rule}] ${f.anchorId}：${f.detail}`)
  }
  console.log(`\n[lint:content] ${errors.length} 个错误，${warns.length} 个警告`)

  if (errors.length > 0) {
    console.log(
      '\n错误必须修复后方可上线：口吻问题改文案，缺 K1 来源补资料源，'
      + '关联锚点占位按规格 04 §4.1 改成正式 id。',
    )
    process.exitCode = 1
  }
}

/*
 * 只有被当成命令跑时才执行。
 *
 * 不加这道判断，import 这个模块就会跑一遍 lint。更坏的是 errors > 0 时
 * 这里会设 process.exitCode = 1：用例全绿，node --run test 却退 1，
 * 而且输出里没有任何一行说明是谁设的。
 */
const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  run().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
