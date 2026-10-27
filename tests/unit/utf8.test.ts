import { describe, expect, test } from 'vitest'
import {
  completeByteLength, createUtf8StreamDecoder, decodeUtf8,
} from '../../miniprogram/utils/utf8'

/**
 * 增量 UTF-8 解码 —— M3 最必然踩的坑。
 *
 * wx.request 的 onChunkReceived 给 ArrayBuffer，分片边界会把中文字符
 * （3 字节）劈开。按片独立解码就是乱码，而且是「偶尔乱」最难查的那种。
 */

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

describe('decodeUtf8', () => {
  test.each([
    ['ASCII', 'hello world'],
    ['中文', '你好，世界'],
    ['中英混排', '号舍 haoshe 很窄'],
    ['标点', '「这格子比你宿舍床还窄」——九天九夜。'],
    ['emoji（4 字节）', '走起🎒🏛️'],
    ['空串', ''],
  ])('正确解码 %s', (_label, text) => {
    expect(decodeUtf8(bytesOf(text))).toBe(text)
  })

  test('与 Node 的解码结果一致', () => {
    const text = '江南贡院的号舍，九天九夜吃住考都在里面。🎓'

    expect(decodeUtf8(bytesOf(text))).toBe(Buffer.from(text, 'utf8').toString('utf8'))
  })

  test('坏字节产出替换字符而不是抛错', () => {
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe]))).toContain('�')
  })
})

describe('completeByteLength', () => {
  test('纯 ASCII 全部完整', () => {
    expect(completeByteLength(bytesOf('abc'))).toBe(3)
  })

  test('完整的中文字符全部计入', () => {
    expect(completeByteLength(bytesOf('你好'))).toBe(6)
  })

  test('截断的 3 字节字符被留在外面', () => {
    const full = bytesOf('你') // 3 字节

    expect(completeByteLength(full.subarray(0, 1))).toBe(0)
    expect(completeByteLength(full.subarray(0, 2))).toBe(0)
    expect(completeByteLength(full)).toBe(3)
  })

  test('前面完整、末尾截断时只留末尾', () => {
    const bytes = bytesOf('好你') // 6 字节，截掉最后 1 字节

    expect(completeByteLength(bytes.subarray(0, 5))).toBe(3)
  })

  test('截断的 4 字节 emoji 被留在外面', () => {
    const emoji = bytesOf('🎒') // 4 字节

    expect(completeByteLength(emoji.subarray(0, 3))).toBe(0)
    expect(completeByteLength(emoji)).toBe(4)
  })

  test('连续续字节（坏数据）不会无限挂起', () => {
    expect(completeByteLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])))
      .toBeGreaterThan(0)
  })
})

describe('createUtf8StreamDecoder', () => {
  const feedAllSplits = (text: string, chunkSize: number): string => {
    const bytes = bytesOf(text)
    const decoder = createUtf8StreamDecoder()
    let out = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      out += decoder.push(bytes.subarray(i, i + chunkSize))
    }
    return out + decoder.flush()
  }

  test('逐字节喂入也能还原完整中文', () => {
    const text = '你上次在江南贡院问过科举，今天正好到了号舍。'

    expect(feedAllSplits(text, 1)).toBe(text)
  })

  test.each([1, 2, 3, 4, 5, 7, 13, 64])('分片大小 %i 字节都能还原', (size) => {
    const text = '这格子比你宿舍床还窄，九天九夜吃住考都在里面。🎓 haoshe'

    expect(feedAllSplits(text, size)).toBe(text)
  })

  test('在中文字符正中间切开也不乱码', () => {
    const bytes = bytesOf('号舍')
    const decoder = createUtf8StreamDecoder()

    // 切在第一个字的第 2 字节处
    const first = decoder.push(bytes.subarray(0, 2))
    const second = decoder.push(bytes.subarray(2))

    expect(first).toBe('')
    expect(first + second).toBe('号舍')
  })

  test('截断处被挂起，pending 能看到', () => {
    const decoder = createUtf8StreamDecoder()

    decoder.push(bytesOf('你').subarray(0, 2))

    expect(decoder.pending).toBe(2)
  })

  test('接上后续字节后 pending 归零', () => {
    const bytes = bytesOf('你')
    const decoder = createUtf8StreamDecoder()
    decoder.push(bytes.subarray(0, 2))

    decoder.push(bytes.subarray(2))

    expect(decoder.pending).toBe(0)
  })

  test('flush 吐出残缺尾巴而不是静默丢弃', () => {
    const decoder = createUtf8StreamDecoder()
    decoder.push(bytesOf('你').subarray(0, 2))

    expect(decoder.flush()).not.toBe('')
    expect(decoder.pending).toBe(0)
  })

  test('接受 ArrayBuffer（onChunkReceived 给的就是它）', () => {
    const decoder = createUtf8StreamDecoder()
    const bytes = bytesOf('号舍')

    const out = decoder.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))

    expect(out).toBe('号舍')
  })

  test('空分片不产生输出也不出错', () => {
    const decoder = createUtf8StreamDecoder()

    expect(decoder.push(new Uint8Array(0))).toBe('')
    expect(decoder.flush()).toBe('')
  })
})
