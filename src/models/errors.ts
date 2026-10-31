/** 模型调用的错误分类 —— 决定是否重试、是否告警、给用户看什么 */

export type ModelErrorKind =
  | 'auth'          // Key 无效/过期 —— 不重试，要立刻告警
  | 'rate_limit'    // 限流 —— 重试
  | 'timeout'       // 超时 —— 重试
  | 'network'       // 网络 —— 重试
  | 'server'        // 5xx —— 重试
  | 'bad_request'   // 我们发给供应商的请求不对（参数/模型名）—— 不重试，是我们自己的毛病
  /**
   * 调用方交上来的输入就用不了（读不到图、图超过上限）—— 不重试。
   *
   * 和 bad_request 分开是因为状态码要分开：这一类回 400，调用方改了就能成；
   * bad_request 多半是模型名或 Key 配错，回 400 会让小程序以为是自己传错了，
   * 把排查方向指错一整天。
   */
  | 'invalid_input'
  | 'content_filter'// 内容被供应商拦截 —— 不重试，走降级话术
  | 'parse'         // 返回体不符合预期 —— 不重试
  | 'truncated'     // 预算耗尽、回答为空 —— 不重试（同样的请求结果一样），要告警

export class ModelError extends Error {
  readonly kind: ModelErrorKind
  readonly provider: string
  readonly status?: number
  readonly retryable: boolean

  constructor(input: {
    readonly kind: ModelErrorKind
    readonly provider: string
    readonly message: string
    readonly status?: number
    readonly cause?: unknown
  }) {
    super(input.message, { cause: input.cause })
    this.name = 'ModelError'
    this.kind = input.kind
    this.provider = input.provider
    this.status = input.status
    this.retryable = RETRYABLE.has(input.kind)
  }
}

const RETRYABLE = new Set<ModelErrorKind>(['rate_limit', 'timeout', 'network', 'server'])

export const classifyHttpStatus = (status: number): ModelErrorKind => {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 400 || status === 404 || status === 422) return 'bad_request'
  if (status >= 500) return 'server'
  return 'bad_request'
}

/**
 * 面向用户的降级话术。
 * 规格 03 §5.3 禁止含糊其辞，所以这里不说「可能出错了」，而是明确说不确定。
 */
export const userFacingFallback = (kind: ModelErrorKind): string => {
  switch (kind) {
    case 'content_filter':
      return '这个我不太方便讲——换个角度问问？'
    case 'rate_limit':
    case 'timeout':
    case 'network':
    case 'server':
      return '我这边卡了一下，你再问一遍？'
    case 'invalid_input':
      // 这一类目前只来自「拍一下」，所以话术指向重拍，而不是让人念展牌
      return '这张照片我没打开，你再拍一张试试？'
    case 'auth':
    case 'bad_request':
    case 'parse':
    case 'truncated':
      return '这个我暂时答不上来，展牌上应该写了，你帮我念一下？'
  }
}
