import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_MODEL, assertCandidateRuntimeSupported, childEnvironment, discoverModels, GATEWAY, launchQwen, parseArgs, qwenArguments, resolveTrustedMcpConfig, selectModel, sessionHome } from '../core.mjs'

test('accepts only deliberately supported commands and flags', () => {
  assert.deepEqual(parseArgs(['models', '--json']), { command: 'models', model: undefined, json: true, prompt: '' })
  assert.deepEqual(parseArgs(['run', '--model', 'test-model', 'hello']), { command: 'run', model: 'test-model', json: false, prompt: 'hello' })
  assert.throws(() => parseArgs(['run', '--yolo', 'x']), /Unsupported option/)
  assert.throws(() => parseArgs(['run', '--openai-base-url', 'https://evil.example', 'x']), /Unsupported option/)
  assert.throws(() => parseArgs(['run', '-m', 'a', '--model', 'b', 'hi']), /exactly once/)
  assert.throws(() => parseArgs(['models', 'anything']), /Use: models/)
  assert.deepEqual(parseArgs(['resume', '--model', 'ling-3.0-flash', 'continue']), {command:'resume',model:'ling-3.0-flash',json:false,prompt:'continue'})
})

test('public -p headless text alias preserves candidate safety and explicit model', () => {
  assert.deepEqual(parseArgs(['-p','explain code']), {command:'run',model:undefined,json:false,prompt:'explain code'})
  assert.deepEqual(parseArgs(['--print','--model','ling-3.0-flash','check']), {command:'run',model:'ling-3.0-flash',json:false,prompt:'check'})
  assert.deepEqual(parseArgs(['-m','ling-3.0-flash','-p','check']), {command:'run',model:'ling-3.0-flash',json:false,prompt:'check'})
  assert.deepEqual(parseArgs(['run','-p','hello']), {command:'run',model:undefined,json:false,prompt:'hello'})
  assert.throws(() => parseArgs(['-p']), /Use: run/)
  assert.throws(() => parseArgs(['-p','--print','prompt']), /only once/)
  assert.throws(() => parseArgs(['chat','-p','prompt']), /only supports a single headless run/)
  assert.throws(() => parseArgs(['models','-p','prompt']), /only supports a single headless run/)
  assert.throws(() => parseArgs(['-p','--output-format','json','prompt']), /Unsupported option/)
  assert.throws(() => parseArgs(['login','-p']), /No AI request was sent/)
})

test('legacy subcommands after options never turn into paid prompts', () => {
  for (const argv of [
    ['-m','ling-3.0-flash','login'],
    ['--model','ling-3.0-flash','provider','list'],
    ['-m','ling-3.0-flash','models'],
    ['-m','ling-3.0-flash','auth','status'],
    ['--mcp-config','owner.json','connect'],
  ]) {
    assert.throws(() => parseArgs(argv), /No AI request was sent/, argv.join(' '))
  }
  // Deliberate prompts still work when the command is explicit.
  assert.equal(parseArgs(['run','-m','ling-3.0-flash','login']).prompt,'login')
  assert.equal(parseArgs(['-p','-m','ling-3.0-flash','provider']).prompt,'provider')
})

test('public -c continues only the current project session, with no prompt-route ambiguity', () => {
  assert.deepEqual(parseArgs(['-c']), {command:'resume', model:undefined, json:false, prompt:''})
  assert.deepEqual(parseArgs(['--continue','-m','ling-3.0-flash','inspect']), {command:'resume', model:'ling-3.0-flash', json:false, prompt:'inspect'})
  assert.deepEqual(parseArgs(['-m','ling-3.0-flash','-c','continue']), {command:'resume', model:'ling-3.0-flash', json:false, prompt:'continue'})
  assert.throws(() => parseArgs(['-c','--continue']), /only once/)
  assert.throws(() => parseArgs(['-c','-p','prompt']), /not yet supported/)
  assert.throws(() => parseArgs(['-c','run','prompt']), /not compatible/)
  assert.throws(() => parseArgs(['models','-c']), /not compatible/)
  assert.throws(() => parseArgs(['resume','-c']), /not compatible/)
  assert.equal(parseArgs(['resume','continue']).command,'resume')
})

test('auth status remains a read-only offline command and rejects all other operations', () => {
  assert.deepEqual(parseArgs(['auth','status']), {command:'auth',model:undefined,json:false,prompt:'status'})
  for (const argv of [['auth'],['auth','login'],['auth','logout'],['auth','status','secret'],['auth','status','--model','x']]) {
    assert.throws(() => parseArgs(argv), /Use: auth status/)
  }
  assert.throws(() => parseArgs(['auth','-p','status']), /only supports a single headless run/)
})

test('unsupported public BCCLI commands cannot turn into chargeable model prompts', () => {
  for (const name of [
    'login','logout','mcp','connect','disconnect','integrations',
    'update','serve','acp','plugins','gh-bot','completion','stats',
    'export','import','pr',
  ]) {
    assert.throws(() => parseArgs([name]), /No AI request was sent/, name)
    assert.throws(() => parseArgs([name, 'extra']), /No AI request was sent/, name)
  }
  // Explicit candidate interfaces remain valid.
  assert.equal(parseArgs(['models']).command, 'models')
  assert.equal(parseArgs(['run','hello']).prompt, 'hello')
  assert.equal(parseArgs(['chat']).command, 'chat')
  assert.equal(parseArgs(['resume']).command, 'resume')
})

test('authenticated discovery keeps endpoint and rejects redirects', async () => {
  let checked = false
  const models = await discoverModels({
    key: 'fake-key', fetchImpl: async (url, options) => {
      assert.equal(url, GATEWAY + '/models')
      assert.equal(options.headers.authorization, 'Bearer fake-key')
      assert.equal(options.redirect, 'error')
      checked = true
      return new Response(JSON.stringify({ data: [{ id: 'model-1' }, { id: 'model-1' }, { id: 'model/2' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(checked, true)
  assert.deepEqual(models.map(m => m.id), ['model-1', 'model/2'])
  await assert.rejects(discoverModels({ key: 'fake-key', fetchImpl: async () => { throw new Error('redirect blocked') } }), /no fallback provider/)
})

test('discovery fails closed on invalid keys, no models and 401', async () => {
  await assert.rejects(discoverModels({ key: '', fetchImpl: () => { throw Error('should not fetch') } }), /required/)
  await assert.rejects(discoverModels({ key: 'x', fetchImpl: async () => new Response('{}', { status: 401 }) }), /HTTP 401/)
  await assert.rejects(discoverModels({ key: 'x', fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }), /No valid models/)
  const items = [{ id: 'model-1' }]
  assert.equal(selectModel(items, 'model-1'), 'model-1')
  assert.throws(() => selectModel(items, 'not-listed'), /not available/)
  assert.throws(() => selectModel(items, 'not-listed', 'gmicloud'), /not available for this gmicloud API key/, 'the refusal must name the provider that is actually active')
  assert.throws(() => selectModel(items, 'not-listed', 'botconnector'), /not available for this BotConnector API key/)
  assert.throws(() => selectModel(items, 'foo\nbar'), /Invalid model ID/)
  assert.throws(() => selectModel(items), /Select a model/)
})

test('upstream agent uses the full tool registry with locked gateway and default permissions', () => {
  const args = qwenArguments('model-1', 'hi')
  assert.ok(!args.includes('--bare'))
  assert.deepEqual(args.slice(args.indexOf('--openai-base-url'), args.indexOf('--openai-base-url') + 2), ['--openai-base-url', GATEWAY])
  assert.deepEqual(args.slice(args.indexOf('--approval-mode'), args.indexOf('--approval-mode') + 2), ['--approval-mode', 'default'])
  assert.ok(!args.includes('--yolo'))
  const index = args.indexOf('--append-system-prompt')
  assert.ok(index >= 0, 'runtime facts should be supplied without an AI persona')
  assert.match(args[index + 1], /Client application: BCCLI/)
  assert.match(args[index + 1], /model can change mid-session/)
  assert.ok(!args[index + 1].includes('active_model_id=model-1'), 'model at launch must not be frozen in system prompt')
  assert.ok(!args[index + 1].includes('You are BCCLI'))
  const other = qwenArguments('kimi-k2.7-code', 'hi')
  assert.ok(!other[other.indexOf('--append-system-prompt') + 1].includes('active_model_id='))
  assert.ok(!other.includes('ling-3.0-flash'), 'selected model must never inherit the default as a persona')
  const resumeArgs = qwenArguments('ling-3.0-flash', 'continue', GATEWAY, { continueSession: true })
  assert.ok(resumeArgs.includes('--continue'))
  assert.ok(!resumeArgs.includes('--bare'))
  assert.ok(!qwenArguments('ling-3.0-flash', 'new').includes('--continue'))
})

test('child strips inherited competing provider keys', () => {
  const env = childEnvironment({
    PATH: 'test-path', QWEN_OAUTH: '1', ANTHROPIC_API_KEY: 'old-secret',
    OPENAI_BASE_URL: 'https://evil.example/v1', OPENAI_API_KEY: 'wrong-key',
    BOTCONNECTOR_API_KEY: 'should-not-inherit', QWEN_CODE_RELAUNCH_ARGS: '["--openai-base-url","https://evil.example/v1"]',
  }, 'test-secret', 'model-1', { home: '/tmp/bccli-preview' })
  assert.equal(env.PATH, 'test-path')
  assert.equal(env.QWEN_OAUTH, undefined)
  assert.equal(env.BOTCONNECTOR_API_KEY, undefined)
  assert.equal(env.QWEN_CODE_RELAUNCH_ARGS, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, 'test-secret')
  assert.equal(env.OPENAI_BASE_URL, GATEWAY)
  assert.equal(env.QWEN_HOME, '/tmp/bccli-preview')
})

test('launcher spawns upstream node script directly without shell', async () => {
  let captured
  const spawnImpl = (exe, args, options) => {
    captured = { exe, args, options }
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }
  let closed = false
  const proxyFactory = async ({ key }) => {
    assert.equal(key, 'fake-key')
    return {
      token: 'short-lived-session-token',
      baseUrl: 'http://127.0.0.1:1234/v1',
      close: async () => { closed = true },
    }
  }
  const exit = await launchQwen({
    key: 'fake-key', model: 'model-1', prompt: 'hello',
    env: { PATH: 'ok', BOTCONNECTOR_API_KEY: 'fake-key' },
    entrypoint: 'qwen-entry.js', spawnImpl, proxyFactory,
  })
  assert.equal(exit, 0)
  assert.equal(captured.args[0], 'qwen-entry.js')
  assert.equal(captured.options.shell, false)
  assert.equal(captured.options.env.OPENAI_BASE_URL, 'http://127.0.0.1:1234/v1')
  assert.equal(captured.options.env.OPENAI_API_KEY, 'short-lived-session-token')
  assert.equal(captured.options.env.BOTCONNECTOR_API_KEY, undefined)
  assert.ok(closed, 'loopback proxy must be disposed on child exit')
})

test('Ling default is explicit and never falls back to another model', () => {
  assert.equal(DEFAULT_MODEL, 'ling-3.0-flash')
  assert.equal(selectModel([{ id: DEFAULT_MODEL }], DEFAULT_MODEL), DEFAULT_MODEL)
  assert.throws(() => selectModel([{ id: 'another-model' }], DEFAULT_MODEL), /not available/)
  assert.equal(selectModel([{ id: DEFAULT_MODEL }, { id: 'other-model' }], 'other-model'), 'other-model')
})

test('known Windows Node24 tool-loop crash versions are blocked before launch', () => {
  assert.throws(() => assertCandidateRuntimeSupported({ platform:'win32', nodeVersion:'24.18.0' }), /24\.22\.1/)
  assert.throws(() => assertCandidateRuntimeSupported({ platform:'win32', nodeVersion:'24.22.0' }), /24\.22\.1/)
  assert.doesNotThrow(() => assertCandidateRuntimeSupported({ platform:'win32', nodeVersion:'24.22.1' }))
  assert.doesNotThrow(() => assertCandidateRuntimeSupported({ platform:'win32', nodeVersion:'24.25.0' }))
  assert.doesNotThrow(() => assertCandidateRuntimeSupported({ platform:'win32', nodeVersion:'22.23.4' }))
  assert.doesNotThrow(() => assertCandidateRuntimeSupported({ platform:'linux', nodeVersion:'24.18.0' }))
})

test('identity metadata separates BCCLI client, upstream engine and live AI without pinning a persona', () => {
  const args = qwenArguments('test-switchable-model', '', 'http://127.0.0.1:32323/v1')
  const prompt = args[args.indexOf('--append-system-prompt') + 1]
  assert.match(prompt, /Client application: BCCLI/)
  assert.match(prompt, /upstream coding engine is Qwen Code/)
  assert.match(prompt, /software, not the AI model/)
  assert.match(prompt, /active_model_id/)
  assert.match(prompt, /model can change mid-session/)
  assert.doesNotMatch(prompt, /You are BCCLI|You are Qwen Code|developed by BICO/)
  assert.doesNotMatch(prompt, /ling-3\.0-flash|test-switchable-model/)
  assert.equal(args[args.indexOf('--model') + 1], 'test-switchable-model')
})

test('BCCLI_PREVIEW_HOME relocates the engine home instead of touching the user profile', () => {
  const root = join(tmpdir(), 'bccli-session-home')
  assert.equal(sessionHome('botconnector', { BCCLI_PREVIEW_HOME: root }), root)
  assert.equal(sessionHome('deepseek', { BCCLI_PREVIEW_HOME: root }), join(root, 'sessions-deepseek'))
  assert.throws(() => sessionHome('openai', { BCCLI_PREVIEW_HOME: 'relative/path' }), /must be absolute/)
  assert.ok(sessionHome('deepseek', {}).endsWith(join('.bccli-preview', 'sessions-deepseek')))
})

test('explicit MCP config root follows BCCLI_PREVIEW_HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'bccli-mcp-root-'))
  const file = join(root, 'mcp.json')
  const saved = process.env.BCCLI_PREVIEW_HOME
  try {
    writeFileSync(file, JSON.stringify({ mcpServers: { memory: { command: 'node' } } }) + '\n')
    process.env.BCCLI_PREVIEW_HOME = root
    assert.equal(resolveTrustedMcpConfig(file), realpathSync(file))
  } finally {
    if (saved === undefined) delete process.env.BCCLI_PREVIEW_HOME
    else process.env.BCCLI_PREVIEW_HOME = saved
    rmSync(root, { recursive: true, force: true })
  }
})
