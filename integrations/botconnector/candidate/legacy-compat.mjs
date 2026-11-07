// Stable CLI compatibility bridge. There is only one user-visible executable:
// bccli. Explicit legacy commands continue to use the original BCCLI 0.4.17
// implementation bundled within the same distribution. Never reinterpret a
// legacy subcommand as a chargeable AI prompt.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LEGACY_COMMANDS = new Set([
  'login', 'logout', 'mcp', 'connect', 'disconnect', 'integrations',
  'update', 'serve', 'acp', 'plugins', 'gh-bot', 'completion',
  'stats', 'export', 'import', 'pr',
])
const LEGACY_OPTIONS = new Set([
  '--output-format', '--fail-on-tool-error', '--allow-all',
  '--allowed-tools', '--reasoning', '--lang', '--permission-mode',
  '--worktree', '-w', '--fallback-model', '--base-url',
])

export function legacyCompatibilityMode(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  if (LEGACY_COMMANDS.has(argv[0])) return true
  // Explicit flags from BCCLI 0.4.17 preserve that version's exact
  // semantics, rather than silently mapping to the new engine.
  if (argv.some(arg => LEGACY_OPTIONS.has(arg) || [...LEGACY_OPTIONS].some(flag => arg.startsWith(flag + '=')))) return true
  // The old provider CLI permits custom providers, whereas the new CLI
  // accepts only fixed HTTPS presets. Keep the legacy route explicit.
  if (argv[0] === 'provider' && argv[1] === 'add' && argv.some(arg => ['--url','--name','--key-env'].includes(arg))) return true
  return false
}

// The 0.4.17 CLI reads its own credential store and, for headless use, the
// provider API keys from the environment, so those keys must keep flowing to
// it. What must NOT flow is everything that turns the inherited environment
// into code or traffic injection: NODE_OPTIONS makes Node load arbitrary
// modules into the child, and *_BASE_URL / *_ENDPOINT variables silently
// redirect the legacy client (and its keys) to another host. The new engine
// child gets a strict allowlist; the compatibility child cannot be that strict
// without breaking 0.4.17 auth, so it gets this denylist instead.
const LEGACY_ENV_DENYLIST = /^(NODE_OPTIONS|NODE_PATH|(?:[A-Z0-9]+_)*(?:BASE_URL|BASE_URL_V1|API_BASE|ENDPOINT|ENDPOINT_URL))$/

export function legacyChildEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !LEGACY_ENV_DENYLIST.test(name)))
}

export async function runLegacyCli(argv, { spawnImpl = spawn, node = process.execPath, env = process.env, cwd = process.cwd() } = {}) {
  const entrypoint = fileURLToPath(new URL('./legacy/dist/cli.js', import.meta.url))
  if (spawnImpl === spawn && !existsSync(entrypoint)) throw Error('Bundled BCCLI compatibility files are missing; reinstall the release package. No AI request was sent.')
  const child = spawnImpl(node, [entrypoint, ...argv], {
    cwd, env: legacyChildEnv(env), stdio: 'inherit', shell: false, windowsHide: false,
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)))
  })
}
