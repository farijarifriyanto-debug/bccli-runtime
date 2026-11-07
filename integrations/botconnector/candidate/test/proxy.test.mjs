import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeZeroArgFunctionTools, startGatewayProxy } from '../proxy.mjs'
import { PROVIDERS } from '../providers.mjs'
import { GATEWAY } from '../core.mjs'

test('proxy keeps real key upstream; Qwen gets an expiring local token', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, method: init.method, body: init.body?.toString() })
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    assert.match(proxy.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(proxy.token, 'LOCAL_SESSION_TOKEN')
    const request = { model: 'bc-poc-model', messages: [{ role: 'user', content: 'test' }], stream: true }
    const result = await fetch(proxy.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + proxy.token, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(result.status, 200)
    assert.equal(await result.text(), 'data: [DONE]\n\n')
    assert.deepEqual(seen, [{
      url: GATEWAY + '/chat/completions', method: 'POST',
      auth: 'Bearer REAL_KEY_STAYS_HERE', body: JSON.stringify(request),
    }])
  } finally { await proxy.close() }
})

test('proxy refuses missing token, unexpected endpoint and wrong HTTP method', async () => {
  const seen = []
  const proxy = await startGatewayProxy({ key: 'real', token: 'session',
    fetchImpl: async (...args) => { seen.push(args); return new Response('NO', { status: 200 }) } })
  try {
    const headers = { authorization: 'Bearer session', 'content-type': 'application/json' }
    assert.equal((await fetch(proxy.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
    assert.equal((await fetch(proxy.baseUrl + '/chat/completions', { method: 'POST', headers: { ...headers, authorization: 'Bearer WRONG' }, body: '{}' })).status, 401)
    assert.equal((await fetch(proxy.baseUrl + '/files', { method: 'POST', headers, body: '{}' })).status, 404)
    assert.equal((await fetch(proxy.baseUrl + '/chat/completions', { method: 'GET', headers })).status, 405)
    assert.equal(seen.length, 0)
  } finally { await proxy.close() }
})

test('proxy never follows upstream redirects or exposes upstream error details', async () => {
  let redirectOption
  const proxy = await startGatewayProxy({ key: 'real', token: 'session',
    fetchImpl: async (_url, init) => {
      redirectOption = init.redirect
      throw Error('UPSTREAM_SECRET_RESPONSE_SHOULD_NOT_APPEAR')
    } })
  try {
    const result = await fetch(proxy.baseUrl + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(result.status, 502)
    assert.doesNotMatch(await result.text(), /UPSTREAM_SECRET_RESPONSE_SHOULD_NOT_APPEAR/)
    assert.equal(redirectOption, 'error')
  } finally { await proxy.close() }
})

test('normalizes only missing/nullable parameters on zero-argument functions', () => {
  const withSchema = { type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }
  const noSchema = { type: 'function', function: { name: 'get_goal', description: 'Read goal' } }
  const unknown = { type: 'other', name: 'native_tool' }
  const original = { model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], tools: [withSchema, noSchema, unknown] }
  const updated = normalizeZeroArgFunctionTools(original)
  assert.notEqual(updated, original)
  assert.deepEqual(updated.tools[0], withSchema)
  assert.deepEqual(updated.tools[1], {
    type: 'function', function: { name: 'get_goal', description: 'Read goal', parameters: { type: 'object', properties: {} } },
  })
  assert.deepEqual(updated.tools[2], unknown)
  assert.equal(Object.hasOwn(original.tools[1].function, 'parameters'), false, 'must not mutate caller')
  assert.strictEqual(normalizeZeroArgFunctionTools(updated), updated, 'must be idempotent')
})

test('proxy sends upstream valid parameterless tools without stripping other tools', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'fake-real-key', token: 'fake-local-token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body.toString())
      seen.push(body)
      const target = body.tools[1]?.function
      if (!target?.parameters || target.parameters.type !== 'object') {
        return new Response(JSON.stringify({ error: { message: "Invalid request body, Failed to parse '.tools[1]'" } }), { status: 400 })
      }
      return new Response('data: [DONE]\\n\\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const request = { model: 'agnes-3.0-flash', stream: true, messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: { file: { type: 'string' } } } } },
        { type: 'function', function: { name: 'get_goal', description: 'No arguments needed' } },
      ],
    }
    const result = await fetch(proxy.baseUrl + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer fake-local-token', 'content-type': 'application/json' }, body: JSON.stringify(request),
    })
    assert.equal(result.status, 200)
    assert.equal(seen[0].tools.length, 2, 'keep coding tools enabled')
    assert.deepEqual(seen[0].tools[1].function.parameters, { type: 'object', properties: {} })
    assert.deepEqual(seen[0].tools[0], request.tools[0])
  } finally { await proxy.close() }
})

test('nullable optional read_file fields become single types; required nullable fields stay unchanged', () => {
  const parameters = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      offset: { type: ['integer', 'null'] },
      pages: { type: ['null', 'string'] },
      nested: { type: 'object', properties: { page: { type: ['integer', 'null'] } } },
      required_nullable: { type: ['string', 'null'] },
      multi: { type: ['integer', 'string', 'null'] },
    },
    required: ['file_path', 'required_nullable'],
  }
  const req = { tools: [{ type: 'function', function: { name: 'read_file', parameters } }] }
  const normalized = normalizeZeroArgFunctionTools(req)
  const props = normalized.tools[0].function.parameters.properties
  assert.equal(props.offset.type, 'integer')
  assert.equal(props.pages.type, 'string')
  assert.equal(props.nested.properties.page.type, 'integer')
  assert.deepEqual(props.required_nullable.type, ['string', 'null'])
  assert.deepEqual(props.multi.type, ['integer', 'string', 'null'])
  assert.deepEqual(parameters.properties.offset.type, ['integer', 'null'], 'original must be immutable')
  assert.strictEqual(normalizeZeroArgFunctionTools(normalized), normalized)
})

const OPENAI_TOOL_REASONING_REJECTION = "Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."
const OPENAI_NONE_UNSUPPORTED = "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'."
const openAiRequest = {
  model: 'gpt-6-luna', reasoning_effort: 'high', max_completion_tokens: 4096, stream: true,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
}
const postChat = (proxy, request = openAiRequest) => fetch(proxy.baseUrl + '/chat/completions', {
  method: 'POST', headers: { authorization: 'Bearer ' + proxy.token, 'content-type': 'application/json' }, body: JSON.stringify(request),
})
const jsonError = (message, status = 400) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } })
const OPENAI_RESPONSES_ONLY_404 = 'This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.'
const responsesSse = (model, text) => [
  'event: response.created',
  `data: {"type":"response.created","response":{"id":"resp_w","object":"response","created_at":1793515625,"model":"${model}","status":"in_progress"}}`,
  '',
  'event: response.output_text.delta',
  `data: {"type":"response.output_text.delta","content_index":0,"delta":${JSON.stringify(text)},"item_id":"msg_w","output_index":0}`,
  '',
  'event: response.completed',
  `data: {"type":"response.completed","response":{"id":"resp_w","object":"response","created_at":1793515625,"status":"completed","model":"${model}","output":[{"id":"msg_w","type":"message","status":"completed","content":[{"type":"output_text","text":${JSON.stringify(text)}}],"role":"assistant"}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}`,
  '',
].join('\n')
const responsesToolSse = (model) => [
  'event: response.created',
  `data: {"type":"response.created","response":{"id":"resp_w","object":"response","created_at":1793515625,"model":"${model}","status":"in_progress"}}`,
  '',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"fc_w","type":"function_call","status":"in_progress","arguments":"","call_id":"call_w1","name":"read_file"},"output_index":0,"sequence_number":2}',
  '',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"x\\"}","item_id":"fc_w","output_index":0,"sequence_number":3}',
  '',
  'event: response.completed',
  `data: {"type":"response.completed","response":{"id":"resp_w","object":"response","created_at":1793515625,"status":"completed","model":"${model}","output":[{"id":"fc_w","type":"function_call","status":"completed","arguments":"{\\"path\\":\\"x\\"}","call_id":"call_w1","name":"read_file"}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}`,
  '',
].join('\n')
const sseResponse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

test('proxy retries an OpenAI tool request with reasoning disabled after the chat-completions rejection', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body.toString())
      seen.push(body)
      if (body.reasoning_effort !== 'none') return jsonError(OPENAI_TOOL_REASONING_REJECTION)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const result = await postChat(proxy)
    assert.equal(result.status, 200)
    assert.equal(await result.text(), 'data: [DONE]\n\n')
    assert.equal(seen.length, 2)
    assert.equal(seen[0].reasoning_effort, 'high')
    assert.equal(seen[1].reasoning_effort, 'none')
    assert.deepEqual(seen[1].tools, seen[0].tools)
    assert.deepEqual(seen[1].messages, seen[0].messages)
    assert.equal(seen[1].max_completion_tokens, 4096)
    assert.equal(seen[1].model, 'gpt-6-luna')
  } finally { await proxy.close() }
})

test('proxy retries with reasoning disabled even when the engine sent no reasoning_effort at all', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body.toString())
      seen.push(body)
      if (!Object.hasOwn(body, 'reasoning_effort')) return jsonError(OPENAI_TOOL_REASONING_REJECTION)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const { reasoning_effort: _ignored, ...withoutReasoning } = openAiRequest
    const result = await postChat(proxy, withoutReasoning)
    assert.equal(result.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(Object.hasOwn(seen[0], 'reasoning_effort'), false)
    assert.equal(seen[1].reasoning_effort, 'none')
  } finally { await proxy.close() }
})

test('proxy keeps the original OpenAI explanation when the reasoning-disabled retry fails for an unrelated reason', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body.toString())
      seen.push(body)
      return jsonError(body.reasoning_effort === 'none' ? "Invalid value for 'temperature'." : OPENAI_TOOL_REASONING_REJECTION)
    },
  })
  try {
    const result = await postChat(proxy)
    assert.equal(result.status, 400)
    const text = await result.text()
    assert.match(text, /use \/v1\/responses/, 'the actionable upstream explanation must reach the user')
    assert.doesNotMatch(text, /temperature/, 'the retry error must not replace the original one')
    assert.equal(seen.length, 2, 'an unrelated retry failure must not trigger the responses bridge')
  } finally { await proxy.close() }
})

test('proxy forwards an unrelated OpenAI 400 body unchanged and does not retry', async () => {
  const seen = []
  const message = "Invalid value for 'temperature'."
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (_url, options) => { seen.push(JSON.parse(options.body.toString())); return jsonError(message) },
  })
  try {
    const result = await postChat(proxy)
    assert.equal(result.status, 400)
    assert.match(await result.text(), /Invalid value for 'temperature'/)
    assert.equal(seen.length, 1)
  } finally { await proxy.close() }
})

test('proxy never retries the reasoning rejection for a non-OpenAI endpoint', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    fetchImpl: async (_url, options) => { seen.push(JSON.parse(options.body.toString())); return jsonError(OPENAI_TOOL_REASONING_REJECTION) },
  })
  try {
    const result = await postChat(proxy)
    assert.equal(result.status, 400)
    assert.match(await result.text(), /Function tools with reasoning_effort/)
    assert.equal(seen.length, 1, 'the gateway request must be sent exactly once')
    assert.equal(seen[0].reasoning_effort, 'high')
  } finally { await proxy.close() }
})

test('proxy bridges a responses-only OpenAI model and translates the stream back into chat chunks', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), body: options.body ? JSON.parse(options.body.toString()) : null })
      if (String(url).endsWith('/chat/completions')) return jsonError(OPENAI_RESPONSES_ONLY_404, 404)
      return sseResponse(responsesSse('gpt-5.2-pro', 'OK'))
    },
  })
  try {
    const result = await postChat(proxy, {
      model: 'gpt-5.2-pro', max_completion_tokens: 128, stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(result.status, 200)
    assert.match(result.headers.get('content-type'), /text\/event-stream/)
    const text = await result.text()
    assert.match(text, /"delta":\{"content":"OK"\}/)
    assert.match(text, /"finish_reason":"stop"/)
    assert.match(text, /"usage":\{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11\}/)
    assert.ok(text.trimEnd().endsWith('data: [DONE]'))
    assert.equal(seen.length, 2)
    assert.ok(seen[1].url.endsWith('/responses'))
    assert.deepEqual(seen[1].body.input, [{ role: 'user', content: 'hi' }])
    assert.equal(seen[1].body.max_output_tokens, 128)
    assert.equal(seen[1].body.store, false)
    assert.equal(seen[1].body.stream, true)
    assert.equal(seen[1].body.messages, undefined)
    assert.equal(seen[1].body.stream_options, undefined)
  } finally { await proxy.close() }
})

test('proxy bridges when the reasoning-disabled retry is refused too', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url, options) => {
      const body = options.body ? JSON.parse(options.body.toString()) : null
      seen.push({ url: String(url), body })
      if (String(url).endsWith('/chat/completions')) return jsonError(body.reasoning_effort === 'none' ? OPENAI_NONE_UNSUPPORTED : OPENAI_TOOL_REASONING_REJECTION)
      return sseResponse(responsesSse('gpt-6-astra', 'ASTRA-OK'))
    },
  })
  try {
    const result = await postChat(proxy, { ...openAiRequest, model: 'gpt-6-astra' })
    assert.equal(result.status, 200)
    const text = await result.text()
    assert.match(text, /"content":"ASTRA-OK"/)
    assert.equal(seen.length, 3, 'chat attempt, reasoning-disabled retry, then the responses bridge')
    assert.ok(seen[2].url.endsWith('/responses'))
    assert.equal(seen[2].body.reasoning.effort, 'high', "the engine's reasoning effort survives the bridge (the responses route accepts it)")
    assert.deepEqual(seen[2].body.tools, [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }])
  } finally { await proxy.close() }
})

test('bridged tool calls reach the engine as chat tool_calls deltas', async () => {
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/chat/completions')) {
        const body = JSON.parse(options.body.toString())
        return jsonError(body.reasoning_effort === 'none' ? OPENAI_NONE_UNSUPPORTED : OPENAI_TOOL_REASONING_REJECTION)
      }
      return sseResponse(responsesToolSse('gpt-6-astra'))
    },
  })
  try {
    const result = await postChat(proxy, { ...openAiRequest, model: 'gpt-6-astra' })
    assert.equal(result.status, 200)
    const text = await result.text()
    assert.match(text, /"tool_calls":\[\{"index":0,"id":"call_w1","type":"function","function":\{"name":"read_file","arguments":""\}\}\]/)
    assert.match(text, /"tool_calls":\[\{"index":0,"function":\{"arguments":"\{\\"path\\":\\"x\\"\}"\}\}\]/)
    assert.match(text, /"finish_reason":"tool_calls"/)
  } finally { await proxy.close() }
})

test('after one bridge the same model routes straight to the Responses endpoint', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url, options) => {
      seen.push(String(url))
      if (String(url).endsWith('/chat/completions')) return jsonError(OPENAI_RESPONSES_ONLY_404, 404)
      return sseResponse(responsesSse('gpt-5.2-pro', 'OK'))
    },
  })
  try {
    const request = { model: 'gpt-5.2-pro', max_completion_tokens: 128, stream: true, messages: [{ role: 'user', content: 'hi' }] }
    const first = await postChat(proxy, request)
    assert.equal(first.status, 200)
    await first.text()
    const second = await postChat(proxy, request)
    assert.equal(second.status, 200)
    await second.text()
    assert.equal(seen.filter((url) => url.endsWith('/chat/completions')).length, 1, 'the known responses-only model must not pay the chat round trip again')
    assert.equal(seen.filter((url) => url.endsWith('/responses')).length, 2)
  } finally { await proxy.close() }
})

test('proxy never bridges to /responses for a non-OpenAI endpoint', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    fetchImpl: async (url, options) => {
      seen.push(String(url))
      return jsonError(OPENAI_RESPONSES_ONLY_404, 404)
    },
  })
  try {
    const result = await postChat(proxy, { model: 'gpt-5.2-pro', max_completion_tokens: 128, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.status, 404)
    assert.match(await result.text(), /not supported in the v1\/chat\/completions endpoint/)
    assert.equal(seen.length, 1)
  } finally { await proxy.close() }
})

test('a failing Responses bridge surfaces the Responses error, not the stale chat one', async () => {
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/chat/completions')) return jsonError(OPENAI_RESPONSES_ONLY_404, 404)
      return jsonError('Unsupported value: max_output_tokens is too large.', 400)
    },
  })
  try {
    const result = await postChat(proxy, { model: 'gpt-5.2-pro', max_completion_tokens: 128, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.status, 400)
    assert.match(await result.text(), /max_output_tokens is too large/)
  } finally { await proxy.close() }
})

test('a non-streaming bridged request gets a translated chat completion body', async () => {
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/chat/completions')) return jsonError(OPENAI_RESPONSES_ONLY_404, 404)
      assert.equal(JSON.parse(options.body.toString()).stream, false)
      return new Response(JSON.stringify({
        id: 'resp_n', model: 'gpt-5.2-pro', created_at: 1793515625, status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NONSTREAM-OK' }] }],
        usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    const result = await postChat(proxy, { model: 'gpt-5.2-pro', max_completion_tokens: 128, stream: false, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.status, 200)
    assert.match(result.headers.get('content-type'), /application\/json/)
    const chat = await result.json()
    assert.equal(chat.object, 'chat.completion')
    assert.equal(chat.choices[0].message.content, 'NONSTREAM-OK')
    assert.equal(chat.choices[0].finish_reason, 'stop')
    assert.deepEqual(chat.usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 })
  } finally { await proxy.close() }
})

test('proxy sends OpenAI max_completion_tokens upstream instead of rejected max_tokens', async () => {
  const seen = []
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY_STAYS_HERE', token: 'LOCAL_SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai',
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body.toString()))
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const request = { model: 'gpt-6-luna', max_tokens: 64000, stream: true, messages: [{ role: 'user', content: 'hi' }] }
    const result = await fetch(proxy.baseUrl + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + proxy.token, 'content-type': 'application/json' }, body: JSON.stringify(request),
    })
    assert.equal(result.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].max_completion_tokens, 4096)
    assert.equal(Object.hasOwn(seen[0], 'max_tokens'), false)
    assert.equal(seen[0].model, 'gpt-6-luna')
  } finally { await proxy.close() }
})

test('provider switch is rate-limited so a hijacked session token cannot silently cycle billing', async () => {
  let switches = 0
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY', token: 'SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai', liveProvider: true,
    configured: () => true,
    resolveProfile: (id) => ({ endpoint: PROVIDERS[id].endpoint, key: 'PROVIDER_KEY_' + id }),
    selectProvider: () => { switches += 1 }, rememberModel: () => {},
    fetchImpl: async () => Response.json({ data: [{ id: 'gpt-4.1' }] }),
  })
  try {
    const headers = { authorization: 'Bearer SESSION_TOKEN', 'content-type': 'application/json' }
    const body = JSON.stringify({ action: 'user-selected-provider', provider: 'openai', model: 'gpt-4.1' })
    const first = await fetch(proxy.baseUrl + '/bccli/provider/switch', { method: 'POST', headers, body })
    assert.equal(first.status, 200)
    assert.equal(switches, 1)
    const second = await fetch(proxy.baseUrl + '/bccli/provider/switch', { method: 'POST', headers, body })
    assert.equal(second.status, 429)
    assert.match((await second.json()).error, /Too soon/)
    assert.equal(switches, 1)
  } finally { await proxy.close() }
})

test('provider switch has a per-session cap independent of the cooldown', async () => {
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY', token: 'SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai', liveProvider: true,
    configured: () => true,
    resolveProfile: (id) => ({ endpoint: PROVIDERS[id].endpoint, key: 'PROVIDER_KEY_' + id }),
    selectProvider: () => {}, rememberModel: () => {},
    fetchImpl: async () => Response.json({ data: [{ id: 'gpt-4.1' }] }),
    switchLimits: { cooldownMs: 0, perSession: 2 },
  })
  try {
    const headers = { authorization: 'Bearer SESSION_TOKEN', 'content-type': 'application/json' }
    const body = JSON.stringify({ action: 'user-selected-provider', provider: 'openai', model: 'gpt-4.1' })
    assert.equal((await fetch(proxy.baseUrl + '/bccli/provider/switch', { method: 'POST', headers, body })).status, 200)
    assert.equal((await fetch(proxy.baseUrl + '/bccli/provider/switch', { method: 'POST', headers, body })).status, 200)
    const third = await fetch(proxy.baseUrl + '/bccli/provider/switch', { method: 'POST', headers, body })
    assert.equal(third.status, 429)
    assert.match((await third.json()).error, /limit reached/)
  } finally { await proxy.close() }
})

test('native key dialogs are rate-limited and capped against dialog-spam social engineering', async () => {
  let prompts = 0
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY', token: 'SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai', liveProvider: true,
    configured: () => true,
    resolveProfile: (id) => ({ endpoint: PROVIDERS[id].endpoint, key: 'PROVIDER_KEY_' + id }),
    secureKeyPrompt: async () => { prompts += 1; return null },
    fetchImpl: async () => Response.json({ data: [{ id: 'gpt-4.1' }] }),
    dialogLimits: { cooldownMs: 0, perSession: 2 },
  })
  try {
    const headers = { authorization: 'Bearer SESSION_TOKEN', 'content-type': 'application/json' }
    const body = JSON.stringify({ action: 'user-confirmed-local-key-dialog', provider: 'openai' })
    const first = await fetch(proxy.baseUrl + '/bccli/provider/key/add', { method: 'POST', headers, body })
    assert.equal(first.status, 200)
    assert.equal((await first.json()).cancelled, true)
    assert.equal(prompts, 1)
    const second = await fetch(proxy.baseUrl + '/bccli/provider/key/add', { method: 'POST', headers, body })
    assert.equal(second.status, 200)
    assert.equal(prompts, 2)
    const third = await fetch(proxy.baseUrl + '/bccli/provider/key/add', { method: 'POST', headers, body })
    assert.equal(third.status, 429)
    assert.match((await third.json()).error, /limit reached/)
    assert.equal(prompts, 2)
  } finally { await proxy.close() }
})

test('native key dialogs refuse an immediate repeat within the cooldown', async () => {
  let prompts = 0
  const proxy = await startGatewayProxy({
    key: 'REAL_KEY', token: 'SESSION_TOKEN',
    endpoint: PROVIDERS.openai.endpoint, initialProvider: 'openai', liveProvider: true,
    configured: () => true,
    resolveProfile: (id) => ({ endpoint: PROVIDERS[id].endpoint, key: 'PROVIDER_KEY_' + id }),
    secureKeyPrompt: async () => { prompts += 1; return null },
    fetchImpl: async () => Response.json({ data: [{ id: 'gpt-4.1' }] }),
  })
  try {
    const headers = { authorization: 'Bearer SESSION_TOKEN', 'content-type': 'application/json' }
    const body = JSON.stringify({ action: 'user-confirmed-local-key-dialog', provider: 'openai' })
    assert.equal((await fetch(proxy.baseUrl + '/bccli/provider/key/add', { method: 'POST', headers, body })).status, 200)
    const second = await fetch(proxy.baseUrl + '/bccli/provider/key/add', { method: 'POST', headers, body })
    assert.equal(second.status, 429)
    assert.match((await second.json()).error, /Too soon/)
    assert.equal(prompts, 1)
  } finally { await proxy.close() }
})