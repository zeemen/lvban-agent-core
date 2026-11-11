import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { MAX_IMAGE_BYTES, toImageUrl } from '../../src/models/image-url.js'

/**
 * imageKey → 可直接塞进 image_url 的字符串（规格 02 §4.2）。
 *
 * 300KB 这道闸不是性能洁癖：视觉这一跳的延迟直接压在「按下快门到出声」上，
 * 一张没压过的手机原图能到 4MB，base64 之后 5MB 多。
 */

const base64Of = (bytes: number): string => Buffer.alloc(bytes, 0x41).toString('base64')

describe('toImageUrl', () => {
  test('http(s) 地址原样透传', async () => {
    expect(await toImageUrl('https://x.test/a.jpg')).toBe('https://x.test/a.jpg')
    expect(await toImageUrl('http://x.test/a.jpg')).toBe('http://x.test/a.jpg')
  })

  test('没超限的 data URI 原样透传', async () => {
    const uri = `data:image/jpeg;base64,${base64Of(1024)}`

    expect(await toImageUrl(uri)).toBe(uri)
  })

  /*
   * 这条是这次补的闸。原先 data: 开头直接 return，300KB 只拦本地文件路径——
   * 而小程序走的恰恰是 data URI（没有对象存储，§4.2 的「直传回传 key」还没有），
   * 于是整条前端压缩要求在实际走的那条路上完全没人把关。
   */
  test('超限的 data URI 要拦，而不是因为开头是 data: 就放过', async () => {
    const uri = `data:image/jpeg;base64,${base64Of(MAX_IMAGE_BYTES + 1)}`

    await expect(toImageUrl(uri)).rejects.toThrow(/300KB/)
  })

  test('拦下来的报错要说清该在哪一边改', async () => {
    const uri = `data:image/jpeg;base64,${base64Of(MAX_IMAGE_BYTES + 1)}`

    await expect(toImageUrl(uri)).rejects.toThrow(/前端压缩/)
  })

  test('本地文件读出来转成 data URI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lvban-img-'))
    const path = join(dir, 'a.jpg')
    await writeFile(path, Buffer.from([1, 2, 3]))

    const url = await toImageUrl(path)

    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })

  test('file:// 前缀也认', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lvban-img-'))
    const path = join(dir, 'a.jpg')
    await writeFile(path, Buffer.from([7]))

    expect(await toImageUrl(`file://${path}`)).toContain('base64,')
  })

  test('超限的本地文件照旧拦', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lvban-img-'))
    const path = join(dir, 'big.jpg')
    await writeFile(path, Buffer.alloc(MAX_IMAGE_BYTES + 1))

    await expect(toImageUrl(path)).rejects.toThrow(/300KB/)
  })

  test('读不到的路径报「读不到图片」，并列出接受的三种形式', async () => {
    await expect(toImageUrl('/nope/nope.jpg')).rejects.toThrow(/读不到图片/)
    await expect(toImageUrl('/nope/nope.jpg')).rejects.toThrow(/data URI/)
  })
})
