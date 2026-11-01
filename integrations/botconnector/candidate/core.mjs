// BCCLI candidate adapter. Intentionally outside the Qwen Code engine.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGatewayProxy } from './proxy.mjs'
import { GATEWAY } from './gateway.mjs'
import { listProviderDefinitions, providerRoot } from './providers.mjs'
import { ensureIsolatedSessionSettings } from './session-settings.mjs'
import { syncDialogModelCatalog } from './dialog-models.mjs'

export { GATEWAY } from './gateway.mjs'
export const DEFAULT_MODEL = 'ling-3.0-flash'

// One engine home per provider keeps /model persistence provider-scoped.
// BCCLI_PREVIEW_HOME (already the owner config/key root) also relocates the
// engine home so isolated runs and tests never write to the real user profile.
export function sessionHome(providerId, env = process.env) {
  const override = typeof env.BCCLI_PREVIEW_HOME === 'string' ? env.BCCLI_PREVIEW_HOME.trim() : ''
  if (override) {
    if (!isAbsolute(override)) throw Error('BCCLI_PREVIEW_HOME must be absolute.')
    return providerId === 'botconnector' ? override : join(override, 'sessions-' + providerId)
  }
  return providerId === 'botconnector'
    ? join(homedir(), '.bccli-preview')
    : join(homedir(), '.bccli-preview', 'sessions-' + providerId)
}

// Qwen Code 0.26.3 Windows tool-loop exits cleanly with Node 24.22.1
// (GitHub Actions), but repeatedly crashes on Windows Node 24.18.0
// with libuv UV_HANDLE_CLOSING after delivering the tool result.
// This guard affects ONLY the isolated candidate, not public BCCLI.
export function assertCandidateRuntimeSupported({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(String(nodeVersion))
  if (!parts) throw Error('Cannot verify the Node.js version for BCCLI candidate.')
  const major = Number(parts[1]), minor = Number(parts[2]), patch = Number(parts[3])
  if (platform === 'win32' && major === 24 && (minor < 22 || (minor === 22 && patch < 1))) {
    throw Error('Windows Node.js ' + nodeVersion + ' may crash after coding tools. Use Node.js 24.22.1 or newer, or Node.js 22.23.4. No coding request was sent.')
  }
}
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/
const ALLOWED = new Set(['models', 'run', 'chat', 'resume', 'auth', 'provider'])
// Public BCCLI commands are not supported by this isolated candidate. Do
// not accidentally treat them as AI prompts, which could spend user credits.
const PUBLIC_ONLY_COMMANDS = new Set([
  'login', 'logout', 'mcp', 'connect', 'disconnect',
  'integrations', 'update', 'serve', 'acp', 'plugins', 'gh-bot',
  'completion', 'stats', 'export', 'import', 'pr',
])

export function parseArgs(argv) {
  const args = [...argv]
  // Public BCCLI accepts options before subcommands. This candidate does
  // not: reject those spellings rather than accidentally charging for a
  // prompt such as "-m ling login" or "-m ling models".
  if (!args.includes('-p') && !args.includes('--print') && !args.includes('-c') && !args.includes('--continue') && !ALLOWED.has(args[0])) {
    let firstWord
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '--model' || flag === '-m' || flag === '--mcp-config') { i++; continue }
      if (flag.startsWith('-')) continue
      firstWord = flag
      break
    }
    if (firstWord && (PUBLIC_ONLY_COMMANDS.has(firstWord) || ALLOWED.has(firstWord))) {
      throw Error('Subcommand "' + firstWord + '" must come first in this candidate. No AI request was sent.')
    }
  }
  // Check old public subcommands BEFORE rewriting -p to run: otherwise
  // "login -p" might accidentally become a billable model prompt.
  if (args.length && PUBLIC_ONLY_COMMANDS.has(args[0])) {
    throw Error('Command "' + args[0] + '" is available only in public BCCLI 0.4.17, not this isolated candidate. No AI request was sent.')
  }
  // Qwen handles both -c and -r natively. Never combine the two session modes.
  if (args.some(a => a === '-c' || a === '--continue') && args.some(a => a === '-r' || a === '--resume')) {
    throw Error('Use either -c or -r, not both. No AI request was sent.')
  }
  // The public -c/--continue resumes the last *current-project* session.
  // Candidate Qwen 'resume' already implements that behavior in isolation.
  const continueFlags = args.filter(a => a === '-c' || a === '--continue')
  if (continueFlags.length > 1) throw Error('Specify -c / --continue only once.')
  if (continueFlags.length) {
    if (args.some(a => a === '-p' || a === '--print')) throw Error('Combining -c with -p is not yet supported by the candidate.')
    const otherArgs = args.filter(a => a !== continueFlags[0])
    if (ALLOWED.has(otherArgs[0])) throw Error('-c / --continue is not compatible with an explicit subcommand; use resume directly.')
    args.splice(args.indexOf(continueFlags[0]), 1)
    args.unshift('resume')
  }
  // Keep public BCCLI's common noninteractive invocation as a safe alias.
  // Do not imply parity with public JSON/stream-json.
  const printIndexes = args.flatMap((arg, i) => arg === '-p' || arg === '--print' ? [i] : [])
  if (printIndexes.length > 1) throw Error('Specify -p / --print only once.')
  if (printIndexes.length === 1) {
    args.splice(printIndexes[0], 1)
    if (ALLOWED.has(args[0]) && args[0] !== 'run') {
      throw Error('-p / --print only supports a single headless run, not ' + args[0] + '.')
    }
    if (args[0] !== 'run') args.unshift('run')
  }
  const command = ALLOWED.has(args[0]) ? args.shift() : 'chat'
  let model, mcpConfig, provider, json = false, resumeSession
  const prompt = []
  while (args.length) {
    const arg = args.shift()
    if (arg === '-r' || arg === '--resume') {
      if (command !== 'chat' || resumeSession !== undefined) throw Error('Use -r [SESSION_UUID] only once for interactive chat.')
      const next = args[0]
      if (next && !next.startsWith('-')) {
        if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(next)) {
          throw Error('Session ID must be a UUID. No AI request was sent.')
        }
        resumeSession = args.shift()
      } else {
        resumeSession = null // Native Qwen --resume with no ID opens its own session picker.
      }
      continue
    }
    if (arg === '--model' || arg === '-m') {
      if (model !== undefined || !args.length) throw Error('Specify --model exactly once with an ID.')
      model = args.shift()
      continue
    }
    if (arg === '--provider') {
      if (provider !== undefined || !args.length || args[0].startsWith('-')) throw Error('--provider requires exactly one provider ID.')
      provider = args.shift()
      continue
    }
    if (arg === '--mcp-config') {
      if (mcpConfig !== undefined || !args.length || args[0].startsWith('-')) throw Error('--mcp-config requires exactly one absolute path.')
      mcpConfig = args.shift()
      continue
    }
    if (arg === '--json' && command === 'models') { json = true; continue }
    if (arg.startsWith('-')) throw Error('Unsupported option. POC intentionally blocks passthrough flags.')
    prompt.push(arg)
  }
  if (command === 'provider' && (model || mcpConfig || provider || json)) throw Error('Use: provider list | add ID | use ID | remove ID.')
  if (command === 'auth' && (model || mcpConfig || json || prompt.join(' ') !== 'status')) throw Error('Use: auth status (offline and read-only).')
  if (command === 'models' && (model || mcpConfig || prompt.length)) throw Error('Use: models [--json].')
  if (resumeSession !== undefined && prompt.length) throw Error('Session picker cannot be combined with a prompt.')
  if (command === 'run' && !prompt.length) throw Error('Use: run --model MODEL "prompt".')
  return { command, model, json, prompt: prompt.join(' '), ...(mcpConfig ? { mcpConfig } : {}), ...(provider ? { provider } : {}), ...(resumeSession !== undefined ? { resumeSession } : {}) }
}

export async function discoverModels({ key, fetchImpl = fetch, endpoint = GATEWAY }) {
  if (!key || !key.trim()) throw Error('BOTCONNECTOR_API_KEY is required (do not supply it as a CLI argument).')
  let response
  try {
    response = await fetchImpl(endpoint + '/models', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    })
  } catch {
    throw Error('Gateway model discovery failed; no fallback provider was used.')
  }
  if (!response.ok) throw Error('Gateway model discovery failed (HTTP ' + response.status + ').')
  let payload
  try { payload = await response.json() }
  catch { throw Error('Gateway model discovery returned invalid JSON.') }
  if (!Array.isArray(payload?.data)) throw Error('Gateway model discovery returned no model list.')
  const models = new Map()
  for (const item of payload.data) {
    if (typeof item?.id === 'string' && MODEL_ID.test(item.id)) {
      models.set(item.id, { id: item.id, name: typeof item.name === 'string' ? item.name : item.id })
    }
  }
  if (!models.size) throw Error('No valid models available to this key.')
  return [...models.values()]
}

export function selectModel(models, value, providerId) {
  if (!value) throw Error('Select a model with --model ID or BOTCONNECTOR_MODEL_ID; run models first.')
  if (!MODEL_ID.test(value)) throw Error('Invalid model ID.')
  if (!models.some((item) => item.id === value)) {
    const label = providerId && providerId !== 'botconnector' ? providerId : 'BotConnector'
    throw Error(`Model is not available for this ${label} API key.`)
  }
  return value
}

export function qwenArguments(model, prompt, endpoint = GATEWAY, { mcpConfig, continueSession = false, resumeSession, projectDir = process.cwd() } = {}) {
  if (continueSession && resumeSession !== undefined) throw Error('Cannot combine native Qwen --continue with --resume.')
  // Use the full upstream coding agent. The real provider key remains only in
  // the parent-owned loopback gateway proxy; this child receives a short-lived
  // proxy token, never a provider credential.
  const args = [
    '--auth-type', 'openai',
    '--openai-base-url', endpoint,
    '--model', model, '--approval-mode', 'default',
    '--telemetry=false',
  ]
  // Keep the current workspace visible to the upstream instruction loader.
  // Full mode uses upstream workspace trust and approval boundaries for
  // project-level settings, MCP integrations, and hooks.
  if (!isAbsolute(projectDir)) throw Error('BCCLI workspace root must be absolute.')
  args.push('--include-directories', projectDir)
  // The active AI can change with /model. Do not embed the STARTUP model
  // here: doing so would falsely identify a later selected model.
  // The BotConnector local proxy adds the actual request model to each
  // chat call, without forcing the AI to impersonate BCCLI.
  args.push('--append-system-prompt',
    'Client application: BCCLI. The upstream coding engine is Qwen Code, which is software, not the AI model answering the user. Identify the responding AI using active_model_id from current-request runtime metadata (the model can change mid-session). If no current model ID is available, state that it is unknown. Do not call the assistant Qwen Code or BCCLI as if either were the AI model, and do not infer who developed the active model from the application or engine brand. In full engine mode, use tool_search and tool_call to discover supported tools not initially listed, including web_fetch; web_search needs a configured search backend and must not be fabricated. For coding tasks, prefer glob to locate files, grep_search to find source references, read_file to inspect exact content, write_file only to create an explicitly requested file, apply_patch for atomic multi-hunk updates to one existing file after read_file and approval, edit for minimal replacements, and run_shell_command for tests or build steps using tool approval. Preserve existing file contents when not explicitly authorized to overwrite. After executing, report actual output, exit codes, and failed tests; never claim that commands ran without evidence.')
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  if (continueSession) args.push('--continue')
  if (resumeSession !== undefined) args.push('--resume', ...(resumeSession === null ? [] : [resumeSession]))
  if (prompt) args.push(prompt)
  return args
}

export function childEnvironment(base, key, model, { endpoint = GATEWAY, home, providerId = 'botconnector', searchAvailable = false } = {}) {
  const env = { ...base }
  // Prevent inherited cross-provider auth from becoming another route or key.
  for (const name of [
    'QWEN_OAUTH', 'BOTCONNECTOR_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'QWEN_MODEL',
    'QWEN_CODE_RELAUNCH_ARGS', 'BRAVE_SEARCH_API_KEY',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'QWENCLOUD_API_KEY',
    'QWENCLOUD_TOKEN_PLAN_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY',
  ]) delete env[name]
  for (const entry of Object.values(listProviderDefinitions())) {
    if (entry.env) delete env[entry.env]
  }
  env.OPENAI_API_KEY = key
  env.OPENAI_BASE_URL = endpoint
  env.OPENAI_MODEL = model
  env.QWEN_MODEL = model
  env.QWEN_HOME = home ?? sessionHome(providerId, env)
  env.BCCLI_ACTIVE_PROVIDER = providerId
  env.BCCLI_WEB_SEARCH_AVAILABLE = searchAvailable ? '1' : '0'
  env.CLI_TITLE = 'BCCLI - ' + process.cwd().split(/[\\/]/).filter(Boolean).at(-1)
  env.QWEN_CODE_SKIP_UPDATE_CHECK_ONCE = 'true' // Never query or install upstream Qwen releases.
  return env
}

// Explicit MCP servers run local commands on startup, so they must originate
// from a config file the user deliberately placed outside any cloned project.
// Full engine auto-discovery is subject to upstream workspace trust. The owner
// config root follows BCCLI_PREVIEW_HOME so an isolated home is fully isolated.
export function resolveTrustedMcpConfig(input, { home = providerRoot() } = {}) {
  if (!input) return undefined
  if (!isAbsolute(input)) throw Error('MCP config must use an absolute path.')
  let realHome, file, stats
  try {
    realHome = realpathSync(home)
    file = realpathSync(input)
    stats = lstatSync(input)
  } catch {
    throw Error('MCP config must be a readable file in the owner config directory.')
  }
  if (stats.isSymbolicLink() || !stats.isFile() || dirname(file) !== realHome) {
    throw Error('MCP config must be a regular file directly in the owner config directory.')
  }
  let config
  try { config = JSON.parse(readFileSync(file, 'utf8')) }
  catch { throw Error('MCP config must contain valid JSON.') }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
    !config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    throw Error('MCP config must contain mcpServers.')
  }
  if (Object.keys(config).some((name) => name !== 'mcpServers')) {
    throw Error('MCP config may contain only mcpServers (no provider or credential overrides).')
  }
  if (!Object.keys(config.mcpServers).length) throw Error('MCP config must define at least one server.')
  return file
}

export function resolveQwenEntrypoint() {
  // The preview includes an integrity-pinned Apache-2.0 engine snapshot.
  // Keep its original source attribution; npm must not install Qwen or
  // its optional audio-capture install hook as a dependency.
  const bundled = fileURLToPath(new URL('./engine/cli-entry.js', import.meta.url))
  if (existsSync(bundled)) return bundled
  // Local source checkout still supports original dependency for tests.
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@qwen-code/qwen-code/package.json')), 'cli-entry.js')
}

export async function launchQwen({ key, model, prompt, mcpConfig, continueSession = false, resumeSession, upstream = GATEWAY, providerId = 'botconnector', env = process.env, entrypoint = resolveQwenEntrypoint(), spawnImpl = spawn, proxyFactory = startGatewayProxy, catalog }) {
  // The real API key never enters Qwen, its tools, or any MCP child process.
  // Only this launcher retains it while the ephemeral proxy is running.
  const searchApiKey = env.BRAVE_SEARCH_API_KEY
  const proxy = await proxyFactory({ key, endpoint: upstream, liveProvider: true, initialProvider: providerId, searchApiKey })
  try {
    const args = [entrypoint, ...qwenArguments(model, prompt, proxy.baseUrl, { mcpConfig, continueSession, resumeSession, projectDir: process.cwd() })]
    const childEnv = childEnvironment(env, proxy.token, model, { endpoint: proxy.baseUrl, providerId, searchAvailable: Boolean(searchApiKey?.trim()) })
    ensureIsolatedSessionSettings(childEnv.QWEN_HOME)
    // The upstream /model picker needs the catalog in modelProviders; without
    // it the dialog only knows the single OPENAI_MODEL route. Never block a
    // launch on catalog failure: chat still works with the startup model.
    if (proxyFactory === startGatewayProxy) {
      try {
        const dialogCatalog = catalog ?? await discoverModels({ key, endpoint: upstream })
        syncDialogModelCatalog(childEnv.QWEN_HOME, { models: dialogCatalog, baseUrl: proxy.baseUrl })
      } catch (error) {
        if (env.BCCLI_DEBUG) console.error('BCCLI: model picker catalog unavailable: ' + (error instanceof Error ? error.message : 'unknown'))
      }
    }
    const child = spawnImpl(process.execPath, args, {
      cwd: process.cwd(), env: childEnv,
      stdio: 'inherit', windowsHide: false, shell: false,
    })
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
    })
  } finally {
    await proxy.close()
  }
}
