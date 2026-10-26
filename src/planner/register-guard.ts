import type { Register } from './decide.js'

/**
 * 人设一致性守卫 —— 规格 03 §8.1 的 forbidden 词表，形式化为生成后校验。
 *
 * 规格 03 §9.1 要求口吻一致性可自动评测；这是规则检查那一半。
 * 命中即打回重写，不是只告警 —— 否则「平等、接梗、不讲课」会迅速退化成导览腔。
 */

const FORBIDDEN_OPENERS: readonly string[] = [
  '接下来', '下面为您介绍', '众所周知', '据史料记载',
]

const FORBIDDEN_PHRASES_BY_REGISTER: Record<Register, readonly string[]> = {
  peer: ['同学', '小朋友', '亲爱的用户', '欢迎来到', '各位游客', '您好'],
  storyteller: ['考你一下', '答对了加分', '你错了'],
  concise: [],
}

/** 规格 03 §5.2：学术解释与传说必须带标记 */
const HEDGE_MARKERS: readonly string[] = [
  '一种说法是', '学界普遍认为', '据考证', '传说', '民间有个说法', '相传',
]

/** 含糊其辞：既没承认不确定，又给了错误暗示（规格 03 §5.3 明确禁止） */
const VAGUE_PATTERNS: readonly RegExp[] = [
  /可能是.{0,10}吧/, /大概是/, /应该差不多/, /我猜.{0,6}是/,
]

export type GuardViolation = {
  readonly rule: 'forbidden_opener' | 'forbidden_phrase' | 'vague_hedging' | 'too_many_facts'
  readonly matched: string
}

export type GuardResult = {
  readonly ok: boolean
  readonly violations: readonly GuardViolation[]
}

const MAX_CONSECUTIVE_FACT_SENTENCES = 2

const splitSentences = (text: string): readonly string[] =>
  text.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s !== '')

/**
 * 「这一句有没有把用户拉进来」。
 *
 * max_consecutive_facts 的意图是不要连续堆砌事实。判据取三类：
 *   1. 提问
 *   2. 类比
 *   3. **用第二人称跟用户说话**
 *
 * 第 3 条原先是枚举短语（「比你」「你上次」「你觉得」…），结果一直在打地鼠：
 * 「这格子比你宿舍床还窄」（企划书原文举的好文案）和
 * 「你在号舍里站一会儿就明白」都被误判成事实堆砌。
 * 直接看有没有「你」更稳：对用户开口本身就打断了事实连击的节奏。
 */
const isQuestionOrAnalogy = (sentence: string): boolean =>
  /[？?]/.test(sentence) ||
  /像|好比|相当于|仿佛|不亚于/.test(sentence) ||
  /你/.test(sentence)

export const checkRegister = (text: string, register: Register): GuardResult => {
  const violations: GuardViolation[] = []

  for (const opener of FORBIDDEN_OPENERS) {
    if (text.startsWith(opener)) {
      violations.push({ rule: 'forbidden_opener', matched: opener })
    }
  }

  for (const phrase of FORBIDDEN_PHRASES_BY_REGISTER[register]) {
    if (text.includes(phrase)) {
      violations.push({ rule: 'forbidden_phrase', matched: phrase })
    }
  }

  for (const pattern of VAGUE_PATTERNS) {
    const hit = pattern.exec(text)
    if (hit !== null) violations.push({ rule: 'vague_hedging', matched: hit[0] })
  }

  // 连说两个事实就该抛个问题或类比（规格 03 §8.1 max_consecutive_facts）
  if (register === 'peer') {
    const sentences = splitSentences(text)
    let streak = 0
    for (const sentence of sentences) {
      streak = isQuestionOrAnalogy(sentence) ? 0 : streak + 1
      if (streak > MAX_CONSECUTIVE_FACT_SENTENCES) {
        violations.push({ rule: 'too_many_facts', matched: sentence.slice(0, 20) })
        break
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

export const hasHedgeMarker = (text: string): boolean =>
  HEDGE_MARKERS.some((marker) => text.includes(marker))
