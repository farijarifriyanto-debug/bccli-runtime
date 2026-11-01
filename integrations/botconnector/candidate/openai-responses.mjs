// Translation between the chat/completions wire shape and OpenAI's Responses
// API for models that only answer on the responses route. Event names, field
// names and refusal texts here were captured from the live API on 2026-11-01
// (gpt-6-astra streaming, gpt-5.2-pro and gpt-5.3-codex refusals), not from
// documentation memory; the fixtures in the tests are those captures.

// Both live refusal texts share this phrase; deprecated-model 404s do not.
export const RESPONSES_ONLY_REJECTION = /not supported in the v1\/chat\/completions endpoint|This is not a chat model/
export const REASONING_NONE_UNSUPPORTED = /'reasoning_effort' does not support 'none'/

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
}

export function toResponsesRequest(parsed) {
  const input = []
  for (const message of parsed.messages ?? []) {
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text) input.push({ role: 'assistant', content: text })
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? '' })
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: textOf(message.content) })
      continue
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      const parts = message.content.flatMap((part) => {
        if (part?.type === 'text') return [{ type: 'input_text', text: part.text ?? '' }]
        if (part?.type === 'image_url') return [{ type: 'input_image', image_url: part.image_url?.url }]
        return []
      })
      input.push({ role: 'user', content: parts })
      continue
    }
    input.push({ role: message.role, content: textOf(message.content) })
  }
  const request = { model: parsed.model, input, stream: parsed.stream === true, store: false }
  const limit = Number(parsed.max_completion_tokens ?? parsed.max_tokens)
  if (Number.isFinite(limit) && limit > 0) request.max_output_tokens = limit
  // 'none' is not a Responses API effort value and the models that reach this
  // route are exactly the ones whose chat-side 'none' retry was refused.
  if (parsed.reasoning_effort && parsed.reasoning_effort !== 'none') request.reasoning = { effort: parsed.reasoning_effort }
  const tools = (parsed.tools ?? []).filter((tool) => tool?.type === 'function' && tool.function?.name)
  if (tools.length) {
    request.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
      ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
    }))
  }
  if (typeof parsed.tool_choice === 'string') request.tool_choice = parsed.tool_choice
  else if (parsed.tool_choice?.type === 'function') request.tool_choice = { type: 'function', name: parsed.tool_choice.function?.name }
  if (parsed.parallel_tool_calls !== undefined) request.parallel_tool_calls = parsed.parallel_tool_calls
  return request
}

// Feed raw Responses SSE text via push(); it returns chat.completion.chunk SSE
// text for whatever completed events arrived. finish() flushes a trailing event
// that lacked its final blank line. The Responses stream has no [DONE] marker,
// so the translator emits one after the terminal event.
export function createResponsesChatTranslator({ includeUsage = false } = {}) {
  let buffer = ''
  let id = ''
  let model = ''
  let created = 0
  const toolIndexByItem = new Map()
  let nextToolIndex = 0
  let sawToolCall = false

  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`

  const translateEvent = (event) => {
    switch (event?.type) {
      case 'response.created':
        id = event.response?.id ?? id
        model = event.response?.model ?? model
        created = event.response?.created_at ?? created
        return ''
      case 'response.output_text.delta':
        return chunk({ content: event.delta })
      case 'response.output_item.added':
        if (event.item?.type !== 'function_call') return ''
        sawToolCall = true
        toolIndexByItem.set(event.item.id, nextToolIndex)
        return chunk({ tool_calls: [{ index: nextToolIndex++, id: event.item.call_id, type: 'function', function: { name: event.item.name, arguments: '' } }] })
      case 'response.function_call_arguments.delta':
        return chunk({ tool_calls: [{ index: toolIndexByItem.get(event.item_id) ?? 0, function: { arguments: event.delta } }] })
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response
        if (response?.id) id = response.id
        if (response?.model) model = response.model
        if (response?.created_at) created = response.created_at
        let out = chunk({}, event.type === 'response.incomplete' ? 'length' : sawToolCall ? 'tool_calls' : 'stop')
        if (includeUsage && response?.usage) {
          out += `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(response.usage) })}\n\n`
        }
        return `${out}data: [DONE]\n\n`
      }
      case 'response.failed':
        return `data: ${JSON.stringify({ error: { message: event.response?.error?.message ?? 'The Responses API request failed.' } })}\n\ndata: [DONE]\n\n`
      default:
        return ''
    }
  }

  const consume = (raw) => {
    let out = ''
    let rest = raw
    let boundary
    while ((boundary = rest.indexOf('\n\n')) >= 0) {
      const block = rest.slice(0, boundary)
      rest = rest.slice(boundary + 2)
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).trim()).join('')
      if (!data || data === '[DONE]') continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      out += translateEvent(event)
    }
    return { out, rest }
  }

  return {
    push(text) {
      const consumed = consume(buffer + text)
      buffer = consumed.rest
      return consumed.out
    },
    finish() {
      if (!buffer.trim()) return ''
      const consumed = consume(`${buffer}\n\n`)
      buffer = ''
      return consumed.out
    },
  }
}

function usageOf(usage) {
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens }
}

export function responsesJsonToChat(response) {
  let text = ''
  const toolCalls = []
  for (const item of response?.output ?? []) {
    if (item?.type === 'message') text += (item.content ?? []).filter((part) => part?.type === 'output_text').map((part) => part.text ?? '').join('')
    else if (item?.type === 'function_call') toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } })
  }
  const message = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: response?.id ?? '',
    object: 'chat.completion',
    created: response?.created_at ?? 0,
    model: response?.model ?? '',
    choices: [{ index: 0, message, finish_reason: response?.status === 'incomplete' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop' }],
    ...(response?.usage ? { usage: usageOf(response.usage) } : {}),
  }
}
