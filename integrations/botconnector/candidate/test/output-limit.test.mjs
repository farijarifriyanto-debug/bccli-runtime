import assert from 'node:assert/strict'
import test from 'node:test'
import { boundChatOutputTokens } from '../proxy.mjs'
import { PROVIDERS } from '../providers.mjs'
import { GATEWAY } from '../core.mjs'

test('cap oversized Qwen max_tokens without altering tools, model, or input', () => {
  const input = { model: 'glm-5.3-flash', max_tokens: 64000, messages: [{role:'user',content:'test'}], tools: [{type:'function',function:{name:'read_file'}}] }
  const result = boundChatOutputTokens(input)
  assert.equal(result.max_tokens, 4096)
  assert.equal(input.max_tokens, 64000)
  assert.strictEqual(result.tools, input.tools)
  assert.strictEqual(result.messages, input.messages)
  assert.equal(result.model, input.model)
})
test('never increase existing small output limits or invent a missing limit', () => {
  for(const tokens of [1, 256, 4096, undefined, null, '64000', -1]) {
    const original = {model:'ling-3.0-flash', max_tokens: tokens}
    assert.strictEqual(boundChatOutputTokens(original),original)
  }
})

test('Kimi K2.7 Code uses max_completion_tokens, not incompatible max_tokens', () => {
  const request={model:'kimi-k2.7-code',max_tokens:64000,messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'read_file'}}]}
  const fixed=boundChatOutputTokens(request)
  assert.equal(fixed.max_completion_tokens,4096)
  assert.equal(Object.hasOwn(fixed,'max_tokens'),false)
  assert.strictEqual(fixed.messages,request.messages)
  assert.strictEqual(fixed.tools,request.tools)
  assert.equal(request.max_tokens,64000)
  assert.equal(boundChatOutputTokens({...request,max_tokens:256}).max_completion_tokens,256)
  assert.equal(boundChatOutputTokens({...request,max_completion_tokens:128}).max_completion_tokens,128)
  assert.equal(boundChatOutputTokens({...request,max_tokens:64000,max_completion_tokens:99999}).max_completion_tokens,4096)
  assert.equal(boundChatOutputTokens({...request,model:'glm-5.3-flash'}).max_tokens,4096)
})
test('Kimi normalizes numeric-string bounds without affecting other models', () => {
  const legacy = {model:'kimi-k2.7-code',max_tokens:'64000'}
  const fixed=boundChatOutputTokens(legacy)
  assert.equal(fixed.max_completion_tokens,4096)
  assert.equal(Object.hasOwn(fixed,'max_tokens'),false)
  assert.equal(legacy.max_tokens,'64000')
  assert.equal(boundChatOutputTokens({model:'kimi-k2.7-code',max_tokens:'128',max_completion_tokens:'32'}).max_completion_tokens,32)
  assert.equal(boundChatOutputTokens({model:'kimi-k2.7-code',max_completion_tokens:'10000'}).max_completion_tokens,4096)
  for(const invalid of ['bad','12e3','9007199254740992']) {
    const input={model:'kimi-k2.7-code',max_tokens:invalid}
    assert.strictEqual(boundChatOutputTokens(input),input)
  }
  const unrelated={model:'glm-5.3-flash',max_tokens:'64000'}
  assert.strictEqual(boundChatOutputTokens(unrelated),unrelated)
})

test('Kimi modern output cap remains bounded and never increases request', () => {
  const original={model:'kimi-k2.7-code',max_completion_tokens:2048}
  assert.strictEqual(boundChatOutputTokens(original),original)
  const fixed=boundChatOutputTokens({...original,max_completion_tokens:10000})
  assert.equal(fixed.max_completion_tokens,4096)
  assert.equal(Object.hasOwn(fixed,'max_tokens'),false)
})

test('OpenAI endpoint uses max_completion_tokens, not rejected max_tokens', () => {
  const endpoint=PROVIDERS.openai.endpoint
  const request={model:'gpt-6-luna',max_tokens:64000,messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'read_file'}}]}
  const fixed=boundChatOutputTokens(request,{endpoint})
  assert.equal(fixed.max_completion_tokens,4096)
  assert.equal(Object.hasOwn(fixed,'max_tokens'),false)
  assert.strictEqual(fixed.messages,request.messages)
  assert.strictEqual(fixed.tools,request.tools)
  assert.equal(request.max_tokens,64000)
  assert.equal(boundChatOutputTokens({model:'gpt-4.1',max_tokens:256},{endpoint}).max_completion_tokens,256)
  assert.equal(boundChatOutputTokens({model:'gpt-5-mini',max_completion_tokens:128},{endpoint}).max_completion_tokens,128)
  assert.equal(boundChatOutputTokens({model:'gpt-5-mini',max_tokens:64000,max_completion_tokens:99999},{endpoint}).max_completion_tokens,4096)
  const noLimit={model:'gpt-6-luna',messages:[{role:'user',content:'hello'}]}
  assert.strictEqual(boundChatOutputTokens(noLimit,{endpoint}),noLimit)
})

test('OpenAI translation is scoped to the OpenAI endpoint, not to model names', () => {
  const request={model:'gpt-6-luna',max_tokens:64000}
  assert.equal(boundChatOutputTokens(request).max_tokens,4096)
  assert.equal(boundChatOutputTokens(request,{endpoint:GATEWAY}).max_tokens,4096)
  assert.equal(Object.hasOwn(boundChatOutputTokens(request,{endpoint:GATEWAY}),'max_completion_tokens'),false)
})
