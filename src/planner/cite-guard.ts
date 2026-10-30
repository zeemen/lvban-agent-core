/**
 * must_cite 回查校验 —— 规格 03 §5.1 的受限通道那一半。
 *
 * 规格要求六类字段（年代、文物名称、尺寸、出土地点、人物关系、历史事件）
 * 不能自由生成，查不到就整段打回或降级为「不确定」。这里做的是能用规则
 * 判死的那三类：年代、尺寸、出土地点。文物名称、人物关系、历史事件不是
 * 正则能框住的形状，留给审校，不在这里假装覆盖。
 *
 * 两层强弱分明，因为它们的误判代价完全不同：
 *
 * 一、containment（硬，决定 ok）：值必须在证据里原样出现过。
 *     拦的是凭空捏造——模型说出一个任何资料里都没有的年代。无阈值、无误报：
 *     要么在，要么不在。命中就打回重写，再不过就降级（规格 03 §5.3）。
 *
 * 二、attribution（软，只报不拦）：值前面那段话，得和证据里同一个值前面
 *     那段话对得上（去标点后有长度 ≥3 的公共子串）。拦的是张冠李戴。
 *
 *     这一层是 2026-10-30 线上实测逼出来的：问「明远楼是什么时候建的」，
 *     5 次里有 1 次答「资料里说法不一，有说南宋乾道四年，也有说明永乐年间」。
 *     两个年代都在证据里，containment 完全拦不住——错的是 1168 属于江南贡院
 *     而不是明远楼，是挂错了主语。
 *
 *     它是启发式，会误伤省略主语的口语（「这座楼是明永乐年间建的」挂不上，
 *     但那句话没错）。这个产品说的就是口语，所以不让它触发重写：
 *     先记进 evidenceRefs，拿真实流量量出误报率再决定要不要升级成硬拦。
 */

const MIN_SUBJECT_OVERLAP = 3

export type CiteLabel = '年代' | '尺寸' | '出土地点'

export type CitedValue = {
  readonly label: CiteLabel
  readonly value: string
  readonly at: number
}

export type CiteViolation = {
  readonly rule: 'unsupported_value' | 'misattributed_value'
  readonly label: CiteLabel
  readonly value: string
}

export type CiteResult = {
  /** 只看硬违规：软违规报出来但不拦，理由见文件头 */
  readonly ok: boolean
  readonly violations: readonly CiteViolation[]
}

const PATTERNS: readonly { readonly label: CiteLabel; readonly pattern: RegExp }[] = [
  // 朝代纪年：南宋乾道四年 / 明永乐年间 / 清道光年间。非贪婪，否则会吞掉后面的句子
  {
    label: '年代',
    pattern: /(?:[东西南北])?(?:夏|商|周|秦|汉|魏|晋|隋|唐|宋|辽|金|元|明|清|民国)[一-鿿]{1,4}?(?:年间|年)/g,
  },
  { label: '年代', pattern: /(?:公元前|公元)?\d{1,4}年/g },
  { label: '年代', pattern: /(?:公元前|公元)?[\d一二三四五六七八九十]{1,3}世纪/g },
  { label: '尺寸', pattern: /\d+(?:\.\d+)?(?:厘米|毫米|公里|米|公斤|千克|克|斤|吨|cm|mm|kg)/g },
  {
    label: '出土地点',
    pattern: /(?:出土于|发现于|出自)[一-鿿]{2,10}?(?:墓|遗址|窑|寺|塔|城|村|山|湖)/g,
  },
]

/**
 * 归一化：全角数字转半角、去掉空白。
 * 「１１６８ 年」和「1168年」是同一个事实，不该因为输入法不同就判成没依据。
 */
export const normalize = (text: string): string =>
  text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')

/** 抽出回答里所有 must_cite 值，按出现顺序，去重 */
export const extractCitedValues = (text: string): readonly CitedValue[] => {
  const norm = normalize(text)
  const found = PATTERNS.flatMap(({ label, pattern }) =>
    [...norm.matchAll(pattern)].map((m): CitedValue => ({
      label, value: m[0], at: m.index ?? 0,
    })))

  const seen = new Set<string>()
  return [...found]
    .sort((a, b) => a.at - b.at)
    .filter((v) => (seen.has(v.value) ? false : (seen.add(v.value), true)))
}

/** 去掉标点和空白：比对主语时，「，有说」这种虚词不该算共同点 */
const bare = (text: string): string => text.replace(/[^一-鿿\dA-Za-z]/g, '')

const splitSentences = (text: string): readonly string[] =>
  text.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s !== '')

/** 两段话有没有长度 ≥ n 的公共子串 */
const sharesSpan = (a: string, b: string, n: number): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  for (let i = 0; i + n <= short.length; i += 1) {
    if (long.includes(short.slice(i, i + n))) return true
  }
  return false
}

/** 值在某句话里的「主语位」——它前面那段，去掉标点 */
const subjectOf = (sentence: string, value: string): string =>
  bare(sentence.slice(0, sentence.indexOf(value)))

/**
 * 回答里这个值挂的主语，和证据里同一个值挂的主语，对得上吗。
 * 只要有任意一条证据句对得上就算对得上——同一个事实可能被多处提到。
 */
const attributionHolds = (
  answerSentence: string, value: string, evidenceSentences: readonly string[],
): boolean => {
  const claimed = subjectOf(answerSentence, value)
  return evidenceSentences
    .filter((e) => e.includes(value))
    .some((e) => sharesSpan(claimed, subjectOf(e, value), MIN_SUBJECT_OVERLAP))
}

/**
 * 回查一段回答。evidence 传 K3 片段的正文加锚点里有 K1 背书的成稿，
 * 也就是「这句话当时能看到的全部资料」。
 */
export const checkCitations = (
  answer: string, evidence: readonly string[],
): CiteResult => {
  const values = extractCitedValues(answer)
  if (values.length === 0) return { ok: true, violations: [] }

  const normAnswer = normalize(answer)
  const evidenceSentences = evidence.flatMap((e) => splitSentences(normalize(e)))
  const evidenceText = evidenceSentences.join('')

  const violations = values.flatMap(({ label, value }): readonly CiteViolation[] => {
    // 根本不在资料里：硬伤，不必再追问它挂给了谁
    if (!evidenceText.includes(value)) {
      return [{ rule: 'unsupported_value', label, value }]
    }
    const sentence = splitSentences(normAnswer).find((s) => s.includes(value))
    if (sentence !== undefined && attributionHolds(sentence, value, evidenceSentences)) {
      return []
    }
    return [{ rule: 'misattributed_value', label, value }]
  })

  return {
    ok: !violations.some((v) => v.rule === 'unsupported_value'),
    violations,
  }
}

/**
 * 打回重写时的追加指令。只针对硬违规：软违规不触发重写，
 * 拿它去要求模型改口，等于让它为一句没错的话道歉。
 */
export const buildCiteRewriteSuffix = (
  violations: readonly CiteViolation[], maxChars: number,
): string => {
  const unsupported = violations.filter((v) => v.rule === 'unsupported_value')
  if (unsupported.length === 0) return ''
  const list = unsupported.map((v) => `${v.label}「${v.value}」`).join('、')
  return `【重写要求】上一版说了资料里查不到的${list}。`
    + `这几处要么删掉，要么改成「我不确定」并把人引向现场说明牌，不要换一个数字重说一遍。`
    + `仍然只说一段话，${maxChars} 字以内。`
}
