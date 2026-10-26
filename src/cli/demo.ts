import { uuidv7 } from 'uuidv7'
import { onArrive, onQuestion } from '../agent/respond.js'
import { streamQuestion } from '../agent/respond-stream.js'
import { endJourney, startJourney } from '../context/journey.js'
import { ingestFixes } from '../context/ingest.js'
import { pool } from '../db/pool.js'
import { distillJourney } from '../memory/distill.js'
import { getMemoryHooks } from '../memory/retrieval.js'
import * as repo from '../memory/repo.js'
import { readLedger, resetLedger } from '../models/router.js'

/**
 * 「第二次使用时的分水岭」验证脚本 —— 规格 04 §3.4。
 *
 * 这是 MVP 最该被验证的一条链路：同一个点位，第一次是提问开场，
 * 第二次因为记忆命中而改成跨次连接开场。如果这条跑不出差异，
 * 产品就还只是一个导览工具（企划书第 12 节）。
 */

const JIANGNAN_GONGYUAN = { lat: 32.0211, lng: 118.7905 }
const DEMO_OPENID = 'demo_h5_companion'

const rule = (title: string): void => {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`)
}

const freshUser = async (): Promise<string> => {
  // 每次 demo 用全新用户，避免上一轮记忆干扰对照
  const openid = `${DEMO_OPENID}_${Date.now()}`
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, wx_openid, nickname, age_band, default_mode)
     VALUES ($1,$2,'演示用户·大二','19_24','companion') RETURNING id`,
    [uuidv7(), openid],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('创建用户失败')
  return id
}

/** 两个定位点：满足去抖（连续 2 次）与最小停留（20s） */
const fixesAtGongyuan = (base: Date): readonly {
  lat: number; lng: number; accuracyM: number; at: Date; speedMps: number
}[] => [
  { ...JIANGNAN_GONGYUAN, accuracyM: 12, at: base, speedMps: 0.4 },
  { ...JIANGNAN_GONGYUAN, accuracyM: 14, at: new Date(base.getTime() + 25_000), speedMps: 0.3 },
]

const runJourney = async (input: {
  readonly userId: string
  readonly label: string
  readonly askQuestions: boolean
}): Promise<string> => {
  const journey = await startJourney({
    userId: input.userId, mode: 'companion', party: 'solo',
    sceneId: 'fuzimiao', trackConsent: 'visited_points_only',
  })
  console.log(`\n[${input.label}] 旅程开始 journey=${journey.id.slice(0, 8)}… track_consent=${journey.track_consent}`)

  const ingest = await ingestFixes({ journeyId: journey.id, fixes: fixesAtGongyuan(new Date()) })
  console.log(`[${input.label}] 采集上报：接受 ${ingest.accepted} 丢弃 ${ingest.dropped}`
    + `，围栏事件 ${ingest.events.map((e) => `${e.poiId}:${e.kind}`).join(',') || '无'}`)
  if (ingest.dropReasons.length > 0) {
    console.log(`[${input.label}] 丢弃原因：${[...new Set(ingest.dropReasons)].join(',')}`)
  }

  const arrival = await onArrive({ journeyId: journey.id, poiId: 'fzm_jiangnan_gongyuan' })
  if (arrival.spoke) {
    console.log(`\n  旅伴 > ${arrival.text}`)
    console.log(`  └─ 主动性：${arrival.decision}（${arrival.proactivityReason}）`)
    console.log(`  └─ 规划：开场=${arrival.plan?.openWith} 长度=${arrival.plan?.length} 口吻=${arrival.plan?.register} 留悬念=${arrival.plan?.leaveHook}`)
    console.log(`  └─ 记忆线索：${arrival.context.memoryHooks.join(' / ') || '（空——第一次来，身份层是空的）'}`)
    console.log(`  └─ 用到的锚点要素：${arrival.usedElements.join(', ')}（零模型调用，走缓存内容）`)
    if (arrival.guardViolations.length > 0) {
      console.log(`  └─ ⚠ 口吻守卫命中：${arrival.guardViolations.join(', ')}`)
    }
  } else {
    console.log(`\n  旅伴 > （保持安静：${arrival.vetoedBy ?? arrival.proactivityReason}）`)
  }

  if (input.askQuestions) {
    for (const q of ['古代人怎么考试啊', '那考不上的人怎么办']) {
      console.log(`\n  你   > ${q}`)
      let answer = ''
      for await (const ev of streamQuestion({
        journeyId: journey.id, text: q, poiId: 'fzm_jiangnan_gongyuan',
      })) {
        if (ev.type === 'filler') {
          console.log(`  垫音 > ${ev.text}   ← 本地预合成，0ms 播放（${ev.audioKey}）`)
        }
        if (ev.type === 'sentence' && ev.index === 0) {
          console.log(`  旅伴 > ${ev.text}   ← 第一句 ${ev.atMs}ms，已可送 TTS`)
        }
        if (ev.type === 'sentence' && ev.index > 0) console.log(`         ${ev.text}`)
        if (ev.type === 'error') console.log(`  ⚠ ${ev.message} → ${ev.fallbackText}`)
        if (ev.type === 'done') {
          answer = ev.text
          const t = ev.timing
          console.log(`  └─ 时序：垫音 ${t.fillerAtMs}ms · 首个正文 ${t.firstDeltaMs}ms`
            + ` · 第一句 ${t.firstSentenceMs}ms · 全部 ${t.totalMs}ms · ${t.sentences} 句`)
          console.log(`  └─ 形态：${answer.length} 字 · 上限 ${ev.plan.maxChars}`
            + ` · ${answer.includes('\n') ? '⚠ 含换行' : '单段'}`)
          if (ev.guardViolations.length > 0) {
            console.log(`  └─ ⚠ 口吻守卫命中（流式下只遥测不重写）：${ev.guardViolations.join(', ')}`)
          }
        }
      }
    }
  }

  await endJourney(journey.id)
  const report = await distillJourney(journey.id)
  console.log(`\n[${input.label}] 行后蒸馏：足迹 ${report.footprints} 条`
    + ` · 偏好升级 ${report.preferencesCreated} 条 · 只记一次 ${report.preferencesMentionedOnce} 条`
    + ` · 身份层 ${report.traitsPromoted} 条（候选 ${report.traitsCandidate}）`)
  return journey.id
}

export const runDemo = async (): Promise<void> => {
  resetLedger()
  const userId = await freshUser()

  rule('旅伴 Agent Core · M2 端到端验证')
  console.log('验证目标：同一个点位，第一次与第二次的讲法是否因记忆而不同（规格 04 §3.4 / 假设 H5）')
  console.log(`用户：${userId}（全新档案，身份层为空）`)

  rule('第一次旅程：夫子庙 · 江南贡院')
  await runJourney({ userId, label: '第 1 次', askQuestions: true })

  rule('此刻 agent 记住了什么（规格 01 §7「我的记忆」）')
  const prefs = await repo.listPreferences(userId)
  for (const p of prefs) {
    console.log(`  · ${p.dimension} = ${p.value}　强度 ${Number(p.strength).toFixed(2)}`
      + `　状态 ${p.status}　来源 ${p.source}　跨 ${p.journey_count} 次旅程`)
  }
  const footprints = await repo.listFootprints(userId, 10)
  for (const f of footprints) {
    console.log(`  · 足迹：${f.city}·${f.place}　停留 ${f.dwell_sec}s`
      + `　提问 ${f.question_count} 次　兴趣 ${f.interest_signal}　主题 [${f.topics.join(',')}]`)
  }
  const hooks = await getMemoryHooks({
    userId, currentPlace: 'fzm_jiangnan_gongyuan', currentCity: '南京', topic: '科举',
  })
  console.log(`  · 检索到的 memory_hooks：${hooks.hooks.map((h) => h.text).join(' / ') || '（空）'}`)
  console.log(`  · token 预算占用：${hooks.tokenEstimate}（上限 600）`)
  for (const h of hooks.hooks) {
    console.log(`      └─ 「${h.text}」为什么：${JSON.stringify(h.evidence)}`)
  }

  rule('第二次旅程：同一个点位，看讲法有没有变')
  await runJourney({ userId, label: '第 2 次', askQuestions: false })

  rule('模型账本（Model Router 记账）')
  console.log(' ', readLedger())
  console.log('\n注：锚点命中的讲解零模型调用；只有自由提问走了 Model Router。')
  console.log('    这正是规格 03 §7.2 的缓存策略——成本与首句延迟同时受控。\n')
}
