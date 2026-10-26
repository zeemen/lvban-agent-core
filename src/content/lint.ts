import { closePool } from '../db/pool.js'
import { closeRedis } from '../db/redis.js'
import type { PlanDecision } from '../planner/decide.js'
import { checkRegister, hasHedgeMarker } from '../planner/register-guard.js'
import { renderFromAnchor } from '../planner/render.js'
import { loadAnchors, type Anchor } from './loader.js'

/**
 * 内容静态检查 —— 把规格 03 §9.1 的「口吻一致性」与「三类表述分离」
 * 从运行时告警提前到录入时拦截。
 *
 * 为什么必须在这里拦：锚点是人工精调内容，口吻问题是内容缺陷而不是运行时缺陷。
 * 等到现场用户听见了才在日志里告警，就太晚了。
 */

type Finding = {
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

const lintAnchor = (anchor: Anchor): readonly Finding[] => {
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

const run = async (): Promise<void> => {
  const anchors = await loadAnchors()
  const findings = [...anchors.values()].flatMap(lintAnchor)

  const errors = findings.filter((f) => f.severity === 'error')
  const warns = findings.filter((f) => f.severity === 'warn')

  console.log(`[lint:content] 检查 ${anchors.size} 个锚点`)
  for (const f of findings) {
    const mark = f.severity === 'error' ? '✗' : '!'
    console.log(`  ${mark} [${f.rule}] ${f.anchorId}：${f.detail}`)
  }
  console.log(`\n[lint:content] ${errors.length} 个错误，${warns.length} 个警告`)

  if (errors.length > 0) {
    console.log('\n错误必须修复后方可上线：口吻问题改文案，缺 K1 来源补资料源。')
    process.exitCode = 1
  }
}

run()
  .then(async () => { await closePool(); await closeRedis() })
  .catch(async (error: unknown) => {
    console.error(error)
    await closePool(); await closeRedis()
    process.exit(1)
  })
