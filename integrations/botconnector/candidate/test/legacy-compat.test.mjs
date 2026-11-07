import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { legacyChildEnv, legacyCompatibilityMode, runLegacyCli } from '../legacy-compat.mjs'

test('only explicit legacy features route to bundled stable implementation', () => {
  for (const argv of [
    ['mcp','list'], ['connect','opencode'], ['login','bc-cloud'], ['export'],
    ['plugins','list'], ['acp'], ['serve'], ['stats'], ['pr','12'],
    ['-p','task','--output-format','json'],
    ['-p','task','--output-format=stream-json'],
    ['--reasoning','high','-p','task'], ['--allow-all','-p','task'],
    ['provider','add','custom','--url','https://example.invalid/v1'],
  ]) assert.equal(legacyCompatibilityMode(argv), true, argv.join(' '))
  for (const argv of [
    [], ['chat'], ['--choose'], ['provider','list'],
    ['provider','add','botconnector'], ['-p','describe mcp and plugins'],
    ['-p','task'], ['models'], ['-c'], ['-r'],
  ]) assert.equal(legacyCompatibilityMode(argv), false, argv.join(' '))
})

test('compatibility command invokes bundled legacy CLI through same Node without a shell', async () => {
  const events = []
  const spawnImpl = (binary, args, options) => {
    events.push({ binary, args, options })
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }
  assert.equal(await runLegacyCli(['mcp','list'], {
    spawnImpl, node:'/safe/node', cwd:'/safe/work', env:{BC_TEST:'FAKE'},
  }), 0)
  assert.equal(events.length, 1)
  assert.equal(events[0].binary, '/safe/node')
  assert.match(events[0].args[0], /legacy[\\/]dist[\\/]cli\.js$/)
  assert.deepEqual(events[0].args.slice(1), ['mcp','list'])
  assert.equal(events[0].options.shell, false)
  assert.equal(events[0].options.stdio, 'inherit')
  assert.equal(events[0].options.cwd, '/safe/work')
})

test('legacy child environment drops code injection and endpoint redirection but keeps auth keys', async () => {
  const scrubbed = legacyChildEnv({
    PATH: '/usr/bin',
    BOTCONNECTOR_API_KEY: 'AUTH_KEY_IS_EXPECTED',
    OPENAI_API_KEY: 'PROVIDER_KEY_IS_EXPECTED',
    NODE_OPTIONS: '--require /tmp/evil.js',
    NODE_PATH: '/tmp/modules',
    OPENAI_BASE_URL: 'https://evil.invalid/v1',
    BOTCONNECTOR_BASE_URL_V1: 'https://evil.invalid/v1',
    DASHSCOPE_ENDPOINT: 'https://evil.invalid',
    CUSTOM_ENDPOINT_URL: 'https://evil.invalid',
    BASE_URL: 'https://evil.invalid',
  })
  assert.equal(scrubbed.NODE_OPTIONS, undefined)
  assert.equal(scrubbed.NODE_PATH, undefined)
  assert.equal(scrubbed.OPENAI_BASE_URL, undefined)
  assert.equal(scrubbed.BOTCONNECTOR_BASE_URL_V1, undefined)
  assert.equal(scrubbed.DASHSCOPE_ENDPOINT, undefined)
  assert.equal(scrubbed.CUSTOM_ENDPOINT_URL, undefined)
  assert.equal(scrubbed.BASE_URL, undefined)
  assert.equal(scrubbed.PATH, '/usr/bin')
  assert.equal(scrubbed.BOTCONNECTOR_API_KEY, 'AUTH_KEY_IS_EXPECTED')
  assert.equal(scrubbed.OPENAI_API_KEY, 'PROVIDER_KEY_IS_EXPECTED')

  const events = []
  const spawnImpl = (binary, args, options) => {
    events.push(options)
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }
  assert.equal(await runLegacyCli(['mcp','list'], {
    spawnImpl,
    env: { PATH: '/usr/bin', BOTCONNECTOR_API_KEY: 'AUTH_KEY_IS_EXPECTED', NODE_OPTIONS: '--require /tmp/evil.js', OPENAI_BASE_URL: 'https://evil.invalid/v1' },
  }), 0)
  assert.equal(events[0].env.NODE_OPTIONS, undefined)
  assert.equal(events[0].env.OPENAI_BASE_URL, undefined)
  assert.equal(events[0].env.BOTCONNECTOR_API_KEY, 'AUTH_KEY_IS_EXPECTED')
})

test('legacy errors retain a failing exit code instead of falling back to AI', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 3, null))
    return child
  }
  assert.equal(await runLegacyCli(['mcp','list'], { spawnImpl }), 3)
})
