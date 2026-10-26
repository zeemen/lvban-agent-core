import type { BlockedCategory } from '../domain/enums.js'

/**
 * 规格 01 §3.2：写入黑名单，在语义层生效而非只匹配字段名。
 *
 * M2 用规则表实现；上线前替换为分类器（规格要求「分类器误判宁可偏严」）。
 * 这一层的存在本身就是契约：调用方无法绕过网关直接写库。
 */

type Rule = { readonly category: BlockedCategory; readonly patterns: readonly RegExp[] }

const RULES: readonly Rule[] = [
  {
    category: 'health',
    patterns: [/病|药|过敏|残疾|怀孕|心脏|血压|糖尿病|抑郁|就诊|医院|受伤|骨折/],
  },
  {
    category: 'finance',
    patterns: [/收入|工资|月薪|年薪|存款|资产|房贷|车贷|负债|消费能力|买得起|穷|有钱/],
  },
  {
    category: 'sensitive_identity',
    patterns: [/民族|宗教|信教|基督|穆斯林|佛教徒|党派|政治立场|性取向|同性|指纹|人脸|虹膜/],
  },
  {
    category: 'precise_home',
    patterns: [/家住|住在.*(路|街|号|小区|栋|单元)|学校在|就读于.*(中学|小学|大学).*(路|号)/],
  },
]

/** 推断画像的判定：系统生成的、带评价性的人格标签 */
const INFERRED_PORTRAIT_HINTS: readonly RegExp[] = [
  /性格(内向|外向|孤僻|开朗)/, /看起来(很|挺)/, /应该是个/, /疑似/, /推测.*(家境|学历|职业)/,
]

export type BlocklistVerdict =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly category: BlockedCategory; readonly matched: string }

/**
 * 检查一段待写入内容是否命中黑名单。
 * @param text 待写入的文本内容
 * @param isInferred 该内容是否来自系统推断（推断内容额外过画像规则）
 */
export const checkBlocklist = (text: string, isInferred = false): BlocklistVerdict => {
  if (text.trim() === '') return { blocked: false }

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const hit = pattern.exec(text)
      if (hit !== null) {
        return { blocked: true, category: rule.category, matched: hit[0] }
      }
    }
  }

  if (isInferred) {
    for (const pattern of INFERRED_PORTRAIT_HINTS) {
      const hit = pattern.exec(text)
      if (hit !== null) {
        return { blocked: true, category: 'inferred_portrait', matched: hit[0] }
      }
    }
  }

  return { blocked: false }
}
