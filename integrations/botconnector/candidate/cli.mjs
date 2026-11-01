#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { DEFAULT_MODEL, assertCandidateRuntimeSupported, discoverModels, launchQwen, parseArgs, resolveQwenEntrypoint, resolveTrustedMcpConfig, selectModel, sessionHome } from './core.mjs'
import { prepareBrandedQwen } from './branding.mjs'
import { readDialogSelectedModel } from './dialog-models.mjs'
import { botConnectorCredentialStatus } from './credentials.mjs'
import { resolveProvider, selectedProvider, providerDefinition, isConfigured } from './providers.mjs'
import { runProviderCommand } from './provider-cli.mjs'
import { startupMenu, autoSelectStartup, PROVIDER_SWITCH_EXIT } from './startup-menu.mjs'
import { legacyCompatibilityMode, runLegacyCli } from './legacy-compat.mjs'

// An unreadable or unsafe settings file must not block startup; the picker
// simply falls back to the legacy active-model record.
function dialogModel(providerId) {
  try { return readDialogSelectedModel(sessionHome(providerId, process.env)) } catch { return undefined }
}

function help() {
  console.log([
    'BCCLI | BotConnector Coding Agent',
    'Usage:',
    '  bccli models [--json]',
    '  bccli run --model MODEL "prompt" [--mcp-config OWNER_CONFIG_PATH]',
    '  bccli -p "prompt" [-m MODEL]  (text-only headless alias)',
    '  bccli --version',
    '  bccli chat [--model MODEL] [--mcp-config OWNER_CONFIG_PATH]',
    '  bccli resume [--model MODEL] [prompt]',
    '  bccli -c [-m MODEL] [prompt]  (resume latest current-project session)',
    '  bccli -r [SESSION_UUID] [-m MODEL]  (session picker or specific session)',
    '  bccli auth status  (offline; does not print API key)',
    '  bccli provider add botconnector  (enter a new Cloud key securely)',
    '  bccli provider remove botconnector  (remove only the newly saved key)',
    '  bccli mcp|connect|acp|serve|plugins|completion|stats  (legacy-compatible)',
    '  bccli -p "task" --output-format json|stream-json  (legacy-compatible)',
    '  bccli provider list|add|use|remove [ID]  (manage provider keys)',
    '  bccli models --provider ID  (list models for provider)',
    '  bccli chat --provider ID --model MODEL_ID',
    '  bccli  (open chat directly with active provider and last model)',
    '  bccli --choose  (open provider/model picker explicitly)',
    '  During chat: /provider (menu), /provider add NAME, /provider remove NAME, /provider NAME MODEL_ID.',
    '',
    'Credentials: hidden in-terminal input; Windows DPAPI encrypted per-user storage, or existing login/env.',
    'Provider choices: botconnector, openai, openrouter, deepseek, groq, xai.',
    'Key entry: bccli --choose or bccli provider add botconnector (hidden terminal prompt).',
    'Model choice: --model; BotConnector defaults to ling-3.0-flash. Other providers need --model.',
    'Security: allowlisted provider endpoints, ephemeral local session token, full upstream tools and default approvals.',
    'MCP: --mcp-config accepts owner-controlled JSON directly under ~/.bccli-preview/; upstream project integrations use workspace trust and approval.',
    'JSON/stream-JSON and legacy commands use bundled stable compatibility implementation.',
    'Optional web_search: set BRAVE_SEARCH_API_KEY in parent BCCLI environment; the search key stays out of the coding engine.',
    'Preview: new interactive runtime, Apache-2.0 upstream attribution retained.',
  ].join('\n'))
}

async function main() {
  const argv = process.argv.slice(2)
  if (legacyCompatibilityMode(argv)) return runLegacyCli(argv)
  if (argv.length === 0 && !process.stdin.isTTY) { help(); return 2 }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { help(); return 0 }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    // Offline informational command: never inspect credentials or contact Gateway.
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    console.log(pkg.version)
    return 0
  }
  const forceChoose = argv.length === 1 && argv[0] === '--choose'
  const args = forceChoose ? { command: 'chat', prompt: '', model: undefined } : parseArgs(argv)
  if (args.command === 'provider') return runProviderCommand(args.prompt.trim() ? args.prompt.trim().split(/\s+/) : [])
  if (args.command === 'auth') {
    const status = botConnectorCredentialStatus()
    if (isConfigured('botconnector')) {
      console.log('BotConnector credential configured via ' +
        (status.configured
          ? (status.source === 'environment' ? 'BOTCONNECTOR_API_KEY environment variable.' : 'existing public BCCLI bc-cloud login or new protected BCCLI key.')
          : 'protected BCCLI provider storage.') +
        ' Not verified online. No AI request was sent.')
      return 0
    }
    console.error('BotConnector credential not configured or unreadable. ' +
      'Run "bccli provider add botconnector" or set BOTCONNECTOR_API_KEY. ' +
      'No credential was changed and no AI request was sent.')
    return 1
  }
  if (args.command !== 'models') assertCandidateRuntimeSupported()
  if (args.command === 'models') {
    const profile = resolveProvider(args.provider ?? selectedProvider())
    const models = await discoverModels({ key: profile.key, endpoint: profile.endpoint })
    if (args.json) console.log(JSON.stringify({ data: models }, null, 2))
    else models.forEach((item) => console.log(item.id))
    return 0
  }
  if (!args.prompt && !process.stdin.isTTY) throw Error('Interactive mode requires a TTY; use -p "prompt".')
  const mcpConfig = resolveTrustedMcpConfig(args.mcpConfig)
  let chosen
  let catalog
  const showPicker = args.command === 'chat' && !args.prompt && !args.model
  if (showPicker) {
    chosen = forceChoose ? undefined : await autoSelectStartup({
      ...(args.provider ? { providerId: args.provider } : {}),
      dialogModel,
    })
    if (!chosen) chosen = await startupMenu({
      ...(args.provider ? { currentProvider: () => args.provider } : {}),
      dialogModel,
    })
  } else {
    const providerId = args.provider ?? selectedProvider()
    const profile = resolveProvider(providerId)
    const models = await discoverModels({ key: profile.key, endpoint: profile.endpoint })
    catalog = models
    const requested = args.model ??
      (providerId === 'botconnector' ? (process.env.BOTCONNECTOR_MODEL_ID ?? DEFAULT_MODEL) : undefined)
    if (!requested) throw Error('Use --model MODEL_ID for ' + providerId + '.')
    chosen = { providerId, model: selectModel(models, requested, providerId), key: profile.key, endpoint: profile.endpoint }
  }
  const entrypoint = prepareBrandedQwen(resolveQwenEntrypoint())
  let continueSession = args.command === 'resume'
  let resumeSession = args.resumeSession
  for (;;) {
    console.log('BCCLI | ' + providerDefinition(chosen.providerId).name + ' | ' + chosen.model)
    const code = await launchQwen({
      key: chosen.key, model: chosen.model, prompt: args.prompt,
      mcpConfig, entrypoint, upstream: chosen.endpoint,
      providerId: chosen.providerId, continueSession, resumeSession, catalog,
    })
    if (code !== PROVIDER_SWITCH_EXIT) return code
    if (args.prompt || !process.stdin.isTTY) throw Error('Provider menu requires an interactive terminal.')
    // Older cached engine fallback only. Current /provider switches the live
    // parent proxy and model Config without exiting or exposing API keys.
    resumeSession = undefined // Native picker is used only on the first launch.
    catalog = undefined // The next provider has its own eligible model list.
    const previousProvider = chosen.providerId
    chosen = await startupMenu({ dialogModel })
    continueSession = previousProvider === chosen.providerId
  }
}

main().then((code) => { process.exitCode = code }, (error) => {
  // Error messages deliberately never contain credentials or raw HTTP response bodies.
  console.error('BCCLI: ' + (error instanceof Error ? error.message : 'Unexpected error.'))
  process.exitCode = 1
})
