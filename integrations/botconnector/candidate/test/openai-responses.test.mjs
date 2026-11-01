import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESPONSES_ONLY_REJECTION,
  REASONING_NONE_UNSUPPORTED,
  toResponsesRequest,
  createResponsesChatTranslator,
  responsesJsonToChat,
} from '../openai-responses.mjs'

// Fixtures captured verbatim (ids and timestamps trimmed) from the live OpenAI
// Responses API on 2026-11-01 against gpt-6-astra with stream:true.
const PLAIN_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_1","object":"response","created_at":1793515625,"model":"gpt-6-astra","status":"in_progress"}}',
  '',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}',
  '',
  'event: response.content_part.added',
  'data: {"type":"response.content_part.added","item_id":"msg_1","content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","content_index":0,"delta":"OK","item_id":"msg_1","logprobs":[],"obfuscation":"x","output_index":0,"sequence_number":4}',
  '',
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_1","logprobs":[],"output_index":0,"sequence_number":5,"text":"OK"}',
  '',
  'event: response.content_part.done',
  'data: {"type":"response.content_part.done","item_id":"msg_1","content_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"OK"},"sequence_number":6}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"OK"}],"role":"assistant"},"output_index":0,"sequence_number":7}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":1793515625,"status":"completed","model":"gpt-6-astra","output":[{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"OK"}],"role":"assistant"}],"usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}},"sequence_number":8}',
  '',
].join('\n')

const TOOL_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_2","object":"response","created_at":1793515620,"model":"gpt-6-astra","status":"in_progress"}}',
  '',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_t1","name":"read_file"},"output_index":0,"sequence_number":2}',
  '',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":","item_id":"fc_1","obfuscation":"a","output_index":0,"sequence_number":3}',
  '',
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","delta":"\\"C:/probe.txt\\"}","item_id":"fc_1","obfuscation":"b","output_index":0,"sequence_number":4}',
  '',
  'event: response.function_call_arguments.done',
  'data: {"type":"response.function_call_arguments.done","arguments":"{\\"path\\":\\"C:/probe.txt\\"}","item_id":"fc_1","output_index":0,"sequence_number":5}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"path\\":\\"C:/probe.txt\\"}","call_id":"call_t1","name":"read_file"},"output_index":0,"sequence_number":6}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_2","object":"response","created_at":1793515620,"status":"completed","model":"gpt-6-astra","output":[{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"path\\":\\"C:/probe.txt\\"}","call_id":"call_t1","name":"read_file"}],"usage":{"input_tokens":50,"output_tokens":20,"total_tokens":70}},"sequence_number":7}',
  '',
].join('\n')

function chunksOf(sseText) {
  return sseText.split('\n\n').filter((event) => event.startsWith('data: ') && event !== 'data: [DONE]').map((event) => JSON.parse(event.slice('data: '.length)))
}

test('recognizes the live responses-only refusal texts and nothing else', () => {
  assert.match('This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?', RESPONSES_ONLY_REJECTION)
  assert.match('This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.', RESPONSES_ONLY_REJECTION)
  assert.doesNotMatch('The model `gpt-3.5-turbo` has been deprecated.', RESPONSES_ONLY_REJECTION)
  assert.doesNotMatch('Unsupported parameter: \'max_tokens\' is not supported with this model.', RESPONSES_ONLY_REJECTION)
  assert.match("Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.", REASONING_NONE_UNSUPPORTED)
  assert.doesNotMatch('Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions.', REASONING_NONE_UNSUPPORTED)
})

test('translates the real engine conversation shape into Responses input items', () => {
  // Message shapes captured verbatim from the coding engine on 2026-11-01:
  // system content is a string, user and tool content are arrays of text parts,
  // assistant tool calls use the chat/completions nesting.
  const out = toResponsesRequest({
    model: 'gpt-6-astra',
    stream: true,
    max_completion_tokens: 64000,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: [{ type: 'text', text: 'Read probe.txt' }] },
      { role: 'assistant', content: "I'll read the file.", tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"probe.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'PROBE\n' }] },
      { role: 'assistant', content: 'PROBE' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } }],
  })
  assert.equal(out.model, 'gpt-6-astra')
  assert.equal(out.stream, true)
  assert.equal(out.store, false)
  assert.equal(out.max_output_tokens, 64000)
  assert.equal(out.stream_options, undefined)
  assert.equal(out.messages, undefined)
  assert.equal(out.max_completion_tokens, undefined)
  assert.deepEqual(out.input, [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Read probe.txt' }] },
    { role: 'assistant', content: "I'll read the file." },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"file_path":"probe.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'PROBE\n' },
    { role: 'assistant', content: 'PROBE' },
  ])
  assert.deepEqual(out.tools, [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }])
})

test('maps user image parts and string content', () => {
  const out = toResponsesRequest({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'https://example/x.png', detail: 'high' } }] }],
  })
  assert.deepEqual(out.input, [{ role: 'user', content: [{ type: 'input_text', text: 'what is this' }, { type: 'input_image', image_url: 'https://example/x.png' }] }])
  const plain = toResponsesRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(plain.input, [{ role: 'user', content: 'hi' }])
})

test('maps reasoning effort and never forwards none', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
  assert.deepEqual(toResponsesRequest({ ...base, reasoning_effort: 'high' }).reasoning, { effort: 'high' })
  assert.equal(toResponsesRequest({ ...base, reasoning_effort: 'none' }).reasoning, undefined)
  assert.equal(toResponsesRequest(base).reasoning, undefined)
})

test('falls back to the legacy limit name when the modern one is absent', () => {
  const out = toResponsesRequest({ model: 'm', messages: [], max_tokens: 99 })
  assert.equal(out.max_output_tokens, 99)
})

test('translates the captured plain-text stream into chat chunks with usage and DONE', () => {
  const translator = createResponsesChatTranslator({ includeUsage: true })
  const sse = translator.push(PLAIN_SSE) + translator.finish()
  const chunks = chunksOf(sse)
  assert.equal(chunks.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean).join(''), 'OK')
  assert.equal(chunks[0].id, 'resp_1')
  assert.equal(chunks[0].model, 'gpt-6-astra')
  assert.equal(chunks[0].object, 'chat.completion.chunk')
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop')
  const usageChunk = chunks.find((c) => c.usage)
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 })
  assert.deepEqual(usageChunk.choices, [])
  assert.ok(sse.trimEnd().endsWith('data: [DONE]'))
})

test('omits the usage chunk when the engine did not ask for usage', () => {
  const translator = createResponsesChatTranslator({})
  const chunks = chunksOf(translator.push(PLAIN_SSE) + translator.finish())
  assert.equal(chunks.some((c) => c.usage), false)
})

test('translates the captured tool-call stream into chat tool_calls deltas', () => {
  const translator = createResponsesChatTranslator({})
  const chunks = chunksOf(translator.push(TOOL_SSE) + translator.finish())
  const first = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)
  assert.deepEqual(first.choices[0].delta.tool_calls, [{ index: 0, id: 'call_t1', type: 'function', function: { name: 'read_file', arguments: '' } }])
  const allArgs = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls && !c.choices[0].delta.tool_calls[0].id).map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join('')
  assert.equal(allArgs, '{"path":"C:/probe.txt"}')
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'tool_calls')
})

test('handles SSE split across chunk boundaries', () => {
  const translator = createResponsesChatTranslator({})
  const half = Math.floor(PLAIN_SSE.length / 2)
  const sse = translator.push(PLAIN_SSE.slice(0, half)) + translator.push(PLAIN_SSE.slice(half)) + translator.finish()
  assert.match(sse, /"content":"OK"/)
  assert.ok(sse.trimEnd().endsWith('data: [DONE]'))
})

test('incomplete responses finish with length; failed responses surface the error', () => {
  const incomplete = createResponsesChatTranslator({})
  const incompleteOut = incomplete.push('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"r","model":"m","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n') + incomplete.finish()
  assert.match(incompleteOut, /"finish_reason":"length"/)
  assert.match(incompleteOut, /data: \[DONE\]/)
  const failed = createResponsesChatTranslator({})
  const failedOut = failed.push('event: response.failed\ndata: {"type":"response.failed","response":{"id":"r","model":"m","status":"failed","error":{"message":"Server overloaded"}}}\n\n') + failed.finish()
  assert.match(failedOut, /Server overloaded/)
})

test('translates a non-streaming Responses body into a chat completion', () => {
  const chat = responsesJsonToChat({
    id: 'resp_1',
    model: 'gpt-6-astra',
    created_at: 1793515625,
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
      { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"path":"x"}' },
    ],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  })
  assert.equal(chat.object, 'chat.completion')
  assert.equal(chat.id, 'resp_1')
  assert.equal(chat.model, 'gpt-6-astra')
  assert.equal(chat.choices[0].message.role, 'assistant')
  assert.equal(chat.choices[0].message.content, 'OK')
  assert.deepEqual(chat.choices[0].message.tool_calls, [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }])
  assert.equal(chat.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(chat.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
})
