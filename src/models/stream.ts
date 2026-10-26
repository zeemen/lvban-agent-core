import { ModelError, classifyHttpStatus } from './errors.js'

/**
 * OpenAI 兼容的 SSE 流式解析。与具体供应商无关。
 *
 * 推理模型会先流 reasoning_content、再流 content。思维链不给用户，
 * 但要单独计数——它计费，也是判断「要不要关思考」的依据。
 */

export type StreamEvent =
  /** 思维链增量：不展示给用户，只记账 */
  | { readonly type: 'reasoning'; readonly text: string }
  /** 正文增量 */
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done'
      readonly tokensIn: number
      readonly tokensOut: number
      readonly reasoningTokens: number
    }

type Delta = {
  content?: string | null
  reasoning_content?: string | null
}

type StreamChunk = {
  choices?: { delta?: Delta; finish_reason?: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

export type StreamInput = {
  readonly url: string
  readonly apiKey: string
  readonly body: unknown
  readonly timeoutMs: number
  readonly provider: string
}

const parseErrorMessage = (text: string): string => {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } }
    return body.error?.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

/**
 * 流式调用**不重试**：第一个 delta 送出去之后就无法回头，
 * 中途重试会让用户听到两个开头。连接建立前的失败由调用方决定是否降级到非流式。
 */
export async function* streamSse(input: StreamInput): AsyncGenerator<StreamEvent> {
  let response: Response
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
        accept: 'text/event-stream',
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
      message: isTimeout ? `流式调用超时（${input.timeoutMs}ms）` : `网络错误：${(error as Error).message}`,
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
  if (response.body === null) {
    throw new ModelError({
      kind: 'parse', provider: input.provider, message: '流式响应没有 body',
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tokensIn = 0
  let tokensOut = 0
  let reasoningTokens = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      // 最后一段可能是半行，留到下一轮
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || !trimmed.startsWith('data:')) continue
        const payload = trimmed.slice('data:'.length).trim()
        if (payload === '' || payload === '[DONE]') continue

        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload) as StreamChunk
        } catch {
          // 单个坏分片不该让整段回答失败
          continue
        }

        // 中间分片会带 "usage": null，不能只挡 undefined
        if (chunk.usage != null) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn
          tokensOut = chunk.usage.completion_tokens ?? tokensOut
          reasoningTokens =
            chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens
        }

        const delta = chunk.choices?.[0]?.delta
        if (delta?.reasoning_content != null && delta.reasoning_content !== '') {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (delta?.content != null && delta.content !== '') {
          yield { type: 'delta', text: delta.content }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  yield { type: 'done', tokensIn, tokensOut, reasoningTokens }
}
