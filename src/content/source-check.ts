import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * 采集核验 —— 把「打开来源页，确认这句话真的在里面」变成一次调用。
 *
 * 为什么必须抓回正文、而不是看看域名像不像：2026-10-29 核 kb-gongyuan 时，
 * 我只看见域名是雨花台烈士陵园、内容讲江南贡院，就判定出处错了。真打开页面，
 * 正文原字写着「江南贡院始建于南宋乾道四年(1168)」——来源是对的，错的是我。
 *
 * 三条实测教训定了这个模块的形状：
 *   一、编码。人民网那篇是 GB2312，按 UTF-8 解出来全是乱码，关键词一个都搜不到，
 *       看起来就像「来源里没有这句话」。先定编码再比对。
 *   二、空白。抓回来的正文到处是换行和缩进，要核的句子会被切断，比对前先抹平。
 *   三、失败要和「没命中」分开说。njqh.gov.cn 的证书不被信任，根本打不开——
 *       那是「无法复核」，不是「核过了，没有」。混为一谈会把烂链接当成假资料。
 */

const FETCH_TIMEOUT_MS = 25_000
const CONTEXT_CHARS = 40
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

export type ClaimHit = {
  readonly claim: string
  readonly found: boolean
  /** 命中处的上下文，给人眼复核用；没命中就是空串 */
  readonly context: string
}

export type SourceCheck = {
  readonly ok: boolean
  readonly status: number | null
  readonly title: string
  readonly textLength: number
  readonly claims: readonly ClaimHit[]
  readonly error: string | null
}

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”',
}

const unescapeHtml = (s: string): string =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })

/** 取正文。script/style 整段丢掉——里面的字符串不是页面说的话 */
export const htmlToText = (html: string): string =>
  unescapeHtml(
    html
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t ]+/g, ' ').trim()

export const pageTitle = (html: string): string => {
  const hit = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return hit === null ? '' : unescapeHtml(hit[1] ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 定编码再解。先信响应头，其次信 meta，最后才按 UTF-8。
 * gb2312 / gbk 一律按 GB18030 解：它是前两者的超集，解不坏。
 */
export const decodeBody = (body: ArrayBuffer, contentType: string | null): string => {
  const head = Buffer.from(body.slice(0, 2048)).toString('latin1')
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
    ?? 'utf-8'
  const label = /^(gb2312|gbk|gb18030)$/i.test(declared) ? 'gb18030' : declared
  try {
    return new TextDecoder(label).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

/** 私网、回环、链路本地。这是个内部工具，但它会按人输入的地址发请求 */
const isPrivateAddress = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 127 || a === 0 || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
}

/**
 * 地址能不能抓。只看字面量，域名解析到内网这一层由 checkSource 补上
 * （那一步要 DNS，异步，不适合放在这个同步判断里）。
 */
export const isFetchableUrl = (raw: string): { readonly ok: boolean; readonly reason: string } => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只抓 http/https，不抓 ${url.protocol}` }
  }
  if (isPrivateAddress(url.hostname)) {
    return { ok: false, reason: `${url.hostname} 是本机或内网地址，这个工具只抓公开来源页` }
  }
  return { ok: true, reason: '' }
}

/** 抹掉空白后比对，同时留一张回原文的位置表，好把上下文还原出来 */
const compact = (text: string): { readonly flat: string; readonly map: readonly number[] } => {
  let flat = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''
    if (!/\s/.test(ch)) { flat += ch; map.push(i) }
  }
  return { flat, map }
}

const matchClaims = (text: string, claims: readonly string[]): readonly ClaimHit[] => {
  const { flat, map } = compact(text)
  return claims.map((claim): ClaimHit => {
    const needle = claim.replace(/\s+/g, '')
    if (needle === '') return { claim, found: false, context: '' }
    const at = flat.indexOf(needle)
    if (at < 0) return { claim, found: false, context: '' }
    const from = map[Math.max(0, at - CONTEXT_CHARS)] ?? 0
    const to = map[Math.min(map.length - 1, at + needle.length + CONTEXT_CHARS)] ?? text.length
    return { claim, found: true, context: text.slice(from, to).replace(/\s+/g, ' ').trim() }
  })
}

const failed = (
  claims: readonly string[], error: string, status: number | null = null,
): SourceCheck => ({
  ok: false,
  status,
  title: '',
  textLength: 0,
  claims: claims.map((claim) => ({ claim, found: false, context: '' })),
  error,
})

/** 域名解析到内网也要拦：公网域名可以被指到 127.0.0.1 */
const resolvesToPrivate = async (hostname: string): Promise<boolean> => {
  if (isIP(hostname) !== 0) return false // 字面量已在 isFetchableUrl 查过
  try {
    const hits = await lookup(hostname, { all: true })
    return hits.some((h) => isPrivateAddress(h.address))
  } catch {
    return false // 解析不了就让 fetch 去报错，错误信息更有用
  }
}

/**
 * 抓来源页，逐句核对。
 *
 * 失败与「没命中」严格分开：ok=false 表示这页没看成，别把它当作资料里没有这句话。
 */
export const checkSource = async (input: {
  readonly url: string
  readonly claims: readonly string[]
}): Promise<SourceCheck> => {
  const gate = isFetchableUrl(input.url)
  if (!gate.ok) return failed(input.claims, gate.reason)
  if (await resolvesToPrivate(new URL(input.url).hostname)) {
    return failed(input.claims, '该域名解析到内网地址，不抓')
  }

  try {
    const response = await fetch(input.url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      return failed(input.claims, `HTTP ${response.status}`, response.status)
    }
    const html = decodeBody(
      await response.arrayBuffer(), response.headers.get('content-type'),
    )
    const text = htmlToText(html)
    return {
      ok: true,
      status: response.status,
      title: pageTitle(html),
      textLength: text.length,
      claims: matchClaims(text, input.claims),
      error: null,
    }
  } catch (error) {
    return failed(input.claims, (error as Error).message)
  }
}
