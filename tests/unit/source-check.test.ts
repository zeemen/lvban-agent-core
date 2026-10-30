import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkSource, decodeBody, htmlToText, isFetchableUrl,
} from '../../src/content/source-check.js'

/**
 * 采集核验 —— 运营后台里最该自动化的一步。
 *
 * 为什么要有它：2026-10-29 核 kb-gongyuan 的来源时，我没打开页面，只看域名是
 * 雨花台烈士陵园、内容是江南贡院，就判定「出处是错的」。实际打开一看，页面
 * 正文原字写着「江南贡院始建于南宋乾道四年(1168)」，来源是对的。
 * 凭域名猜会出错，必须抓回正文逐句核对——这个模块就是把那一步变成按钮。
 *
 * 两个实测教训写进了用例：
 *   · 人民网那篇是 GB2312，按 UTF-8 解会得到一堆乱码，关键词一个都搜不到
 *   · 正文里的空白和换行会把要核的句子切断，比对前必须先抹掉空白
 */

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('从 HTML 里取出正文', () => {
  test('脚本和样式整段丢掉，否则 JS 里的字符串会被当成正文', () => {
    const html = '<p>江南贡院</p><script>var s="北宋景德三年"</script><style>.a{}</style>'
    expect(htmlToText(html)).toContain('江南贡院')
    expect(htmlToText(html)).not.toContain('北宋景德三年')
  })

  test('实体转回字符，标签变空白', () => {
    expect(htmlToText('<p>甲&nbsp;乙</p><p>丙</p>')).toMatch(/甲\s*乙\s*丙/)
  })
})

describe('编码', () => {
  const gbk = (s: string): ArrayBuffer => {
    // 用 Node 自带的 GBK 编码表反推不现实，这里直接造一段已知的 GB18030 字节
    const buf = Buffer.from([0xd6, 0xd8, 0xbd, 0xf0, 0xc2, 0xe7]) // 「重金络」
    void s
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }

  test('响应头声明 gb2312 时按 GB18030 解，不然全是乱码', () => {
    expect(decodeBody(gbk('重金络'), 'text/html; charset=gb2312')).toBe('重金络')
  })

  test('meta 里声明 charset 也认——人民网那篇就只在 meta 里写', () => {
    const buf = Buffer.concat([
      Buffer.from('<meta charset="gbk">', 'latin1'),
      Buffer.from([0xd6, 0xd8, 0xbd, 0xf0, 0xc2, 0xe7]),
    ])
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    expect(decodeBody(ab, null)).toContain('重金络')
  })

  test('没声明就按 UTF-8', () => {
    const buf = Buffer.from('江南贡院', 'utf8')
    expect(decodeBody(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), null))
      .toBe('江南贡院')
  })
})

describe('不许拿它去打内网（SSRF）', () => {
  test('只放行 http 和 https', () => {
    expect(isFetchableUrl('file:///etc/passwd').ok).toBe(false)
    expect(isFetchableUrl('https://dfz.nanjing.gov.cn/a.html').ok).toBe(true)
  })

  test('本机与私网地址一律拒绝', () => {
    for (const u of [
      'http://localhost:8080/api', 'http://127.0.0.1/x', 'http://[::1]/x',
      'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(isFetchableUrl(u), u).toMatchObject({ ok: false })
    }
  })

  test('拒绝时给得出理由，面板要显示给人看', () => {
    expect(isFetchableUrl('http://127.0.0.1/x').reason).not.toBe('')
  })
})

describe('逐句核对', () => {
  const page = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  test('命中的句子给出上下文，没命中的明说没命中', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(
      '<title>志说南京</title><p>江南贡院明远楼，始建于明永乐年间，清道光年间重建。</p>')))

    const got = await checkSource({
      url: 'https://dfz.nanjing.gov.cn/x.html',
      claims: ['始建于明永乐年间', '南宋乾道四年'],
    })

    expect(got.ok).toBe(true)
    expect(got.title).toBe('志说南京')
    expect(got.claims[0]).toMatchObject({ claim: '始建于明永乐年间', found: true })
    expect(got.claims[0]?.context).toContain('明永乐年间')
    expect(got.claims[1]).toMatchObject({ claim: '南宋乾道四年', found: false })
  })

  test('正文里换了行的句子也要算命中——抓回来的 HTML 到处是换行', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(
      '<p>江南贡院\n   始建于南宋乾道四年\n（1168年）。</p>')))
    const got = await checkSource({
      url: 'https://x.gov.cn/a', claims: ['江南贡院始建于南宋乾道四年'],
    })
    expect(got.claims[0]?.found).toBe(true)
  })

  test('打不开就如实说打不开，不要把失败说成「没命中」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('certificate has expired')))
    const got = await checkSource({ url: 'https://www.njqh.gov.cn/x', claims: ['乌衣巷'] })
    expect(got.ok).toBe(false)
    expect(got.error).toContain('certificate')
    expect(got.claims.every((c) => !c.found)).toBe(true)
  })

  test('内网地址根本不发请求', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const got = await checkSource({ url: 'http://127.0.0.1:8080/x', claims: ['a'] })
    expect(got.ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })
})
