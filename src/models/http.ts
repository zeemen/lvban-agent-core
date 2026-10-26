import { ModelError, classifyHttpStatus } from './errors.js'

/** OpenAI 兼容接口的 HTTP 调用：超时、重试、错误分类。与具体供应商无关。 */

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 400
const MAX_BACKOFF_MS = 4_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 指数退避 + 抖动：同时被限流的多个请求不该在同一毫秒重试 */
const backoffMs = (attempt: number): number => {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
  return exponential * (0.5 + Math.random() * 0.5)
}

export type PostJsonInput = {
  readonly url: string
  readonly apiKey: string
  readonly body: unknown
  readonly timeoutMs: number
  readonly provider: string
}

export type PostJsonResult = {
  readonly payload: unknown
  readonly latencyMs: number
  readonly attempts: number
}

const parseErrorMessage = (text: string): string => {
  try {
    const body = JSON.parse(text) as { error?: { message?: string }; message?: string }
    return body.error?.message ?? body.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

const attemptOnce = async (input: PostJsonInput): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (error) {
    const isTimeout = error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new ModelError({
      kind: isTimeout ? 'timeout' : 'network',
      provider: input.provider,
      message: isTimeout
        ? `调用超时（${input.timeoutMs}ms）`
        : `网络错误：${(error as Error).message}`,
      cause: error,
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ModelError({
      kind: classifyHttpStatus(response.status),
      provider: input.provider,
      status: response.status,
      message: `HTTP ${response.status}：${parseErrorMessage(text)}`,
    })
  }

  try {
    return await response.json()
  } catch (error) {
    throw new ModelError({
      kind: 'parse',
      provider: input.provider,
      message: '响应不是合法 JSON',
      cause: error,
    })
  }
}

export const postJson = async (input: PostJsonInput): Promise<PostJsonResult> => {
  const started = Date.now()
  let lastError: ModelError | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await attemptOnce(input)
      return { payload, latencyMs: Date.now() - started, attempts: attempt }
    } catch (error) {
      if (!(error instanceof ModelError)) throw error
      lastError = error
      // 认证失败、参数错误重试多少次都一样
      if (!error.retryable || attempt === MAX_ATTEMPTS) break
      await sleep(backoffMs(attempt))
    }
  }

  throw lastError ?? new ModelError({
    kind: 'network', provider: input.provider, message: '调用失败且无错误信息',
  })
}

export type GetJsonInput = {
  readonly url: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly provider: string
}

export const getJson = async (input: GetJsonInput): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(input.url, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (error) {
    throw new ModelError({
      kind: 'network', provider: input.provider,
      message: `网络错误：${(error as Error).message}`, cause: error,
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ModelError({
      kind: classifyHttpStatus(response.status), provider: input.provider,
      status: response.status, message: `HTTP ${response.status}：${parseErrorMessage(text)}`,
    })
  }
  return response.json()
}
