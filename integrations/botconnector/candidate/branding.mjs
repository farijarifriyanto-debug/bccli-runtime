// BCCLI white-label view overlay for the pinned upstream Qwen package.
// Keep the original npm engine untouched; pin the BCCLI transport to its isolated proxy.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { BCCLI_PROVIDER_COMMAND } from './provider-command.mjs'
import { BCCLI_PROVIDER_DIALOG } from './provider-dialog.mjs'
import { BCCLI_MODEL_DIALOG } from './model-dialog.mjs'

const VERSION = '0.26.3'
const SOURCE_HASHES = Object.freeze({
  'chunks/chunk-OYUATJK2.js': '3fa61c12bc1cba19d70151381519be337b99e2e60dac8edf6d066107a8419a1d',
  'chunks/startInteractiveUI-CECFAXVK.js': 'd9acfeb1105032c9edccf223acfc6a8384256099883303c1622b12d92eea0b83',
  'chunks/start-opentui-ui-Q34XCEMN.js': 'e5a8d1ff1ce494f6df26b03023daf2b930cb093ebfbfbcf9e2bcd3b349e6f107',
  'chunks/chunk-OV3EBH6J.js': '3b20ea65e93e6ee00625f9d86906c3d28c45529b4b4dbe72dc050bdae3904505',
  'chunks/chunk-W3YCOEIP.js': '02828393f6e477a7f36cecff876a6af2d36ece3eb838fceb096d9245eb7fc5f7',
  'chunks/chunk-7L4WTOM2.js': '4d8053c956cc7881b7f87ae2c0e96bf1adc942a37ac37de3d76eaeb9367041fc',
  'chunks/chunk-Y6HHV4LC.js': '7ae347a288e5fe60ef37a66485527502db3dd7112207ea4b683ada0bda47952c',
  'chunks/chunk-QUFSNRKR.js': 'f52e1917c7956b02208b39982bbf7b45fb52c294418ebd93f7f2f0677c1aaa2d',
  'chunks/chunk-2PLSL3VQ.js': 'f475f043f1ab8314a64699ebb45e43026bb1a1fe65f1ac259f1898afb8a6c5d9',
  'chunks/chunk-ERV2ECV3.js': '7d2511a8317ee2c44edd2fd62b43966b9acfbfaac79175cd0cc9fb9ed42051c6',
  'chunks/chunk-NCVLAQE5.js': '1dc10e64b04db48ffb4cca02b1a32e5d6395d67ab15ccf175d80f7b4aad8d9af',
  'chunks/server-SJNWHHV4.js': '42ceeddc69dda95fbaac276cbd94e99432892305d169d248e760c9d94aab6eaf',
  'chunks/en-SBI6QJ2J.js': '85fb77f8a9c0fc864f53a55d8a819dfb6ddb98a0c78ef1eaa9af306b313aa6e8',
  'locales/en.js': 'd42369efe23514787a74aa4fb3b63ad339b8ec29edf5973c6aeecd8649a21639',
  'chunks/acpAgent-U6TCKYWP.js': '5a22dd6985c9666f85817ffd0565366b8af2b2771178ab883423a1b774688166',
  'chunks/chunk-2MB4ZSKF.js': 'c442969e3866fe10380be412275f8646305a1ec8437524537189133f61f5eb7b',
  'chunks/chunk-3TK35SQL.js': '63e04f9ae44be6712d75a71ad870fc3c987219fbdd4c3c63a085b264402e797d',
  'chunks/chunk-44WSAMWG.js': 'a85e4033daea57302376e39e8323f50f17c65cb53cbdbddd7cd230ba88e19091',
  'chunks/chunk-4BFQ7QQC.js': '082f99e2b58e97fb09a4c7b5ec905f690b46088f35dbaa0fc974c9f78e7f6b0f',
  'chunks/chunk-55KTWTOV.js': '45516f9524545f18cdae2f1d72092026231007f8961cd2aed4ce3049b5b71c59',
  'chunks/chunk-B3ZFUGTC.js': 'f3f57aafbaeab56ca58f5d3173751d30e5fef815aeaf8dc9b46e6ea9e85eb528',
  'chunks/chunk-GGVWG4SI.js': '945c7f4e9b3697003c165b7bc5d007c9b87140d1fad7be084d7b253d8d2b476c',
})
const BRAND_REVISION = 'bccli-20261101-quota-fastfail-v20'
// Deliberately not Qwen's blue→purple→rose gradient. BotConnector-facing
// coding CLI uses a distinct teal→green→amber palette in dark/light themes.
export const BCCLI_COLORS = Object.freeze(['#00AFA0', '#22C55E', '#EAB308'])
const BCCLI_ASCII = [
  '',
  '██████╗  ██████╗  ██████╗██╗     ██╗',
  '██╔══██╗██╔════╝ ██╔════╝██║     ██║',
  '██████╔╝██║      ██║     ██║     ██║',
  '██╔══██╗██║      ██║     ██║     ██║',
  '██████╔╝╚██████╗ ╚██████╗███████╗██║',
  '╚═════╝  ╚═════╝  ╚═════╝╚══════╝╚═╝',
  '',
].join('\n')

const digest = (value) => createHash('sha256').update(value).digest('hex')

function replaceExactly(text, oldValue, newValue, expectedCount, label) {
  if (text.split(oldValue).length - 1 !== expectedCount) {
    throw Error('BCCLI branding unsupported by installed engine: ' + label)
  }
  return text.split(oldValue).join(newValue)
}

function replaceOnce(text, oldValue, newValue, label) {
  if (text.split(oldValue).length !== 2) {
    throw Error('BCCLI branding unsupported by installed engine: ' + label)
  }
  return text.replace(oldValue, newValue)
}


// Embedded slash commands are part of the upstream renderer bundle. BCCLI's
// Gateway owns authentication and release management, so those commands must
// not open arbitrary upstream provider settings or invoke the upstream npm /
// standalone auto-updater. /model keeps the upstream command, but its primary
// picker is BCCLI's searchable dialog (see model-dialog.mjs); the auxiliary
// pickers stay upstream-owned.
export function guardUpstreamProviderCommands(text) {
  const replacements = [
    {
      command: 'auth',
      detect: 'dialog:"auth"',
      code: BCCLI_PROVIDER_COMMAND,
    },
    {
      command: 'settings',
      detect: 'dialog:"settings"',
      code: 'var settingsCommand={name:"settings",get description(){return "View safe BCCLI settings"},kind:"built-in",supportedModes:["interactive","non_interactive","acp"],action:__name(context=>({type:"message",messageType:"info",content:"BCCLI | BotConnector Settings\\nGateway: https://api.botconnector.id/v1 (fixed)\\nModel: "+(context.services?.config?.getModel?.()||"unknown")+"\\nAuth: /provider add botconnector (masked Windows dialog), /provider remove botconnector; or BOTCONNECTOR_API_KEY override\\nPermissions: ask before file changes and shell commands\\nUse /model to switch AI, /auth for connection help, /permissions for tool approvals, /theme to change appearance. Upstream provider and project-settings editors are disabled."}),"action")};',
    },
    {
      command: 'about',
      detect: 'Qwen Code v',
      code: 'var aboutCommand={name:"status",altNames:["about"],get description(){return "Show BCCLI and BotConnector session diagnostics"},kind:"built-in",supportedModes:["interactive","non_interactive","acp"],canRunDuringStreaming:true,action:__name((context,arg)=>{const config=context.services?.config;const input=String(context.invocation?.args||arg||"").trim().toLowerCase();const message=input==="credits"?"BCCLI coding-agent runtime: based on Qwen Code 0.26.3 (Apache-2.0). Source attribution and license notices are retained in the installed runtime. Product repository: https://github.com/farijarifriyanto-debug/bccli":"BCCLI | BotConnector\\nAI model: "+(config?.getModel?.()||"unknown")+"\\nGateway: https://api.botconnector.id/v1\\nProvider routing: managed by BotConnector\\nPermissions: default (ask)\\nSource: https://github.com/farijarifriyanto-debug/bccli\\nEngine runtime: 0.26.3\\nFor open-source engine credits use /about credits.";return{type:"message",messageType:"info",content:message}},"action")};',
    },
    {
      command: 'docs',
      detect: 'qwen-code-docs',
      code: 'var docsCommand={name:"docs",get description(){return "BCCLI product documentation"},kind:"built-in",supportedModes:["interactive","non_interactive","acp"],action:__name(()=>({type:"message",messageType:"info",content:"BCCLI documentation and releases: https://github.com/farijarifriyanto-debug/bccli#readme"}),"action")};',
    },
    {
      command: 'update',
      detect: 'Check for Qwen Code updates',
      code: 'var updateCommand={name:"update",get description(){return "BCCLI release information"},kind:"built-in",supportedModes:["interactive","non_interactive","acp"],action:__name(()=>({type:"message",messageType:"info",content:"BCCLI updates are managed by the BotConnector release channel (@botconnector/bccli). The upstream engine updater is disabled; use the BotConnector release channel. Visit https://github.com/farijarifriyanto-debug/bccli/releases for product releases."}),"action")};',
    },
  ]
  let result = text
  for (const { command, detect, code } of replacements) {
    const marker = 'var ' + command + 'Command='
    const pos = result.indexOf(marker)
    if (pos < 0 || result.indexOf(marker, pos + 1) !== -1) {
      throw Error('BCCLI upstream command locator changed: ' + command)
    }
    // /status has subCommands after its top-level action. Matching the first
    // generic action end would accidentally remove neighbouring commands!
    // This entire command is bounded by its own esbuild shim boundary.
    const shimBoundary = command === 'about'
    const suffix = shimBoundary ? '};init_esbuild_shims();' : ',"action")};'
    const end = result.indexOf(suffix, pos)
    const maxLength = shimBoundary ? 2500 : 18000
    if (end < 0 || end - pos > maxLength) {
      throw Error('BCCLI upstream command end changed: ' + command)
    }
    const original = result.slice(pos, end + suffix.length)
    if (!original.includes(detect)) {
      throw Error('BCCLI upstream command behavior changed: ' + command)
    }
    result = result.slice(0, pos) + code + (shimBoundary ? 'init_esbuild_shims();' : '') + result.slice(end + suffix.length)
  }
  return result
}

// Human-facing labels only. Do not rewrite license notices, import names, or
// file formats such as QWEN.md, which are still used by the upstream engine.
function renameProductLanguage(text) {
  const labels = [
    ['List tasks across Qwen Code WebShell', 'List tasks across BCCLI agent sessions'],
    ['Automatic backend Qwen Code text', 'Automatic background BCCLI text'],
    ['Goal not restored: it was recorded by an earlier version of Qwen Code', 'Goal not restored: it was recorded by an earlier BCCLI runtime'],
    ['Written by Qwen Code', 'Written by BCCLI'],
    ['Please reinstall Qwen Code', 'Please reinstall BCCLI'],
    ['Agent commands (forwarded to Qwen Code):', 'Agent commands (forwarded to BCCLI):'],
    ['Qwen Code Agent update', 'BCCLI Agent update'],
    ['Qwen Code Agent (', 'BCCLI Agent ('],
    ['Qwen Code Agent', 'BCCLI Agent'],
    ['Run Qwen Code as a local HTTP daemon', 'Run BCCLI as a local HTTP daemon'],
    ['Join another Qwen Code as a runtime', 'Join another BCCLI session as a runtime'],
    ['This is the Qwen Code. We are setting up the context for our chat.', 'This is a coding assistant. We are setting up the context for our chat.'],
    ['Some features may not work perfectly with Qwen Code', 'Some features may not work perfectly with BCCLI'],

    ['How is Qwen doing this session? (optional)', 'How is BCCLI doing this session? (optional)'],
    ['Qwen Code is processing a request', 'BCCLI is processing a request'],
    ['Qwen Code is streaming a model response', 'BCCLI is streaming a model response'],
    ['Qwen Code keeps working', 'BCCLI keeps working'],
    ['You can close this window and return to Qwen Code.', 'You can close this window and return to BCCLI.'],
    ['In interactive Qwen Code sessions', 'In interactive BCCLI sessions'],
    ['Generated with Qwen Code', 'Generated with BCCLI'],
    ['restart Qwen Code', 'restart BCCLI'],
    ['Qwen Code on a host with a microphone', 'BCCLI on a host with a microphone'],
    ['How is Qwen doing this session?', 'How is BCCLI doing this session?'],
    ['To see changes, Qwen Code must be restarted.', 'To see changes, BCCLI must be restarted.'],
    ['To apply the trust changes, Qwen Code must be restarted.', 'To apply trust changes, restart BCCLI.'],
    ["Press 'r' to restart Qwen Code", "Press 'r' to restart BCCLI"],
    ["Qwen Code won't ask before using allowed tools.", "BCCLI won't ask before using allowed tools."],
    ["Qwen Code will ask before using these tools.", "BCCLI will ask before using these tools."],
    ["Qwen Code is not allowed to use denied tools.", "BCCLI is not allowed to use denied tools."],
    ["Qwen Code will be able to read files in this directory", "BCCLI will be able to read files in this directory"],
    ["Qwen Code can read files in the workspace", "BCCLI can read files in the workspace"],
    ['Qwen Code is restarting to apply the trust changes', 'BCCLI is restarting to apply the trust changes'],
    ['Qwen Code understands your codebase', 'BCCLI helps you understand your codebase'],
    ['Available Qwen Code CLI tools:', 'Available BCCLI coding tools:'],
    ['This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.', 'This menu is read-only. Changes to hooks require trusted BCCLI configuration.'],
    ['To re-enable hooks, remove "disableAllHooks" from settings.json or ask Qwen Code.', 'To re-enable hooks, update trusted BCCLI hook configuration.'],
    ['Generate with Qwen Code (Recommended)', 'Generate with BCCLI'],
    ['Trusting a folder allows Qwen Code to execute commands it suggests.', 'Trusting a folder allows BCCLI to execute approved commands.'],
    ['Reinstall Qwen Code or use the npm installation method.', 'Reinstall BCCLI using the official npm package.'],
    ['Do you want to connect ${ideName??"your editor"} to Qwen Code?', 'Do you want to connect ${ideName??"your editor"} to BCCLI?'],
    ['var DEFAULT_TITLE="Qwen Code"', 'var DEFAULT_TITLE="BCCLI"'],
    ['var NOTIFICATION_TITLE="Qwen Code"', 'var NOTIFICATION_TITLE="BCCLI"'],
    ['Qwen Code needs your permission', 'BCCLI needs your permission'],
    ['Qwen Code is waiting for your input', 'BCCLI is waiting for your input'],
    ['title:"Qwen Code"', 'title:"BCCLI"'],
    ['children:"Qwen Code"', 'children:"BCCLI"'],
    ['Approving lets Qwen Code start it and run its tools.', 'Approving lets BCCLI start it and run its tools.'],
    ['var DOCS_URL="https://qwenlm.github.io/qwen-code-docs/"', 'var DOCS_URL="https://github.com/farijarifriyanto-debug/bccli#readme"'],
    ['var HELP_DOCS_URL="https://qwenlm.github.io/qwen-code-docs/"', 'var HELP_DOCS_URL="https://github.com/farijarifriyanto-debug/bccli#readme"'],
    ['Review messages held from other Qwen Code sessions', 'Review messages held from other BCCLI sessions'],
    ['Qwen Code will be able to read, edit, and execute files there.', 'BCCLI will be able to read, edit, and execute files there.'],
    ['Re-run /doctor memory after restarting Qwen Code', 'Re-run /doctor memory after restarting BCCLI'],
    ['restart Qwen Code to recover memory', 'restart BCCLI to recover memory'],
    ['Restart Qwen Code first', 'Restart BCCLI first'],
    ['Right before Qwen Code concludes its response', 'Right before BCCLI concludes its response'],
    ['Manage Qwen Code hooks', 'Manage BCCLI hooks'],
    ['run Qwen Code in one of these supported IDEs', 'run BCCLI in one of these supported IDEs'],
    ['List available Qwen Code tools.', 'List available BCCLI tools.'],
    ['Qwen Code is unavailable in this WSL session', 'BCCLI is unavailable in this WSL session'],
    ['<title>Qwen Code Insights</title>', '<title>BCCLI Insights</title>'],
    ["Set up Qwen Code's status line UI", "Set up BCCLI's status line UI"],
    ['Start Qwen Code with', 'Start BCCLI with'],

  ]
  let out = text
  for (const [before, after] of labels) out = out.split(before).join(after)
  return out
}

// The upstream Select Model list cannot be filtered and the gateway catalog is
// long, so the primary picker becomes BCCLI's searchable one. The auxiliary
// pickers (fast / vision / voice / compaction / image / advisor) keep the
// upstream implementation, which owns their eligibility and persistence rules;
// the BCCLI component delegates to it for those modes.
export function patchModelDialog(text) {
  const renamed = replaceExactly(text,
    'function ModelDialog(',
    'function UpstreamModelDialog(',
    1,
    'model picker upstream rename')
  return replaceOnce(renamed,
    'function UpstreamModelDialog(',
    BCCLI_MODEL_DIALOG + '\nfunction UpstreamModelDialog(',
    'model picker BCCLI search dialog')
}

export function patchUiChunk(file, text) {
  if (file === 'chunks/chunk-Y6HHV4LC.js') {
    // Keep both context formats available and prioritize the vendor-neutral
    // AGENTS.md for all new sessions and /init. This controls file loading,
    // not just the text shown in the terminal.
    return replaceOnce(
      text,
      'var currentMemoryFilename=[DEFAULT_CONTEXT_FILENAME,AGENT_CONTEXT_FILENAME];',
      'var currentMemoryFilename=[AGENT_CONTEXT_FILENAME,DEFAULT_CONTEXT_FILENAME];',
      'AGENTS.md preferred context and backward-compatible QWEN.md fallback')
  }
  if (file === 'chunks/chunk-NCVLAQE5.js') {
    // Hard weekly/monthly usage caps (e.g. Ollama Cloud) never clear by
    // waiting, so the 10x60s rate-limit retry loop only hangs the session.
    // Classify their exact phrasing as quota exhaustion to fast-fail.
    return replaceOnce(
      text,
      'return lower.includes("quota")&&(lower.includes("exhausted")||lower.includes("exceeded"))&&(lower.includes("will reset")||lower.includes("reset at"))',
      'return lower.includes("quota")&&(lower.includes("exhausted")||lower.includes("exceeded"))&&(lower.includes("will reset")||lower.includes("reset at"))||lower.includes("weekly usage limit")||lower.includes("monthly usage limit")',
      'weekly/monthly usage-limit quota fast-fail')
  }
  if ([
    'chunks/acpAgent-U6TCKYWP.js',
    'chunks/chunk-2MB4ZSKF.js',
    'chunks/chunk-3TK35SQL.js',
    'chunks/chunk-44WSAMWG.js',
    'chunks/chunk-4BFQ7QQC.js',
    'chunks/chunk-55KTWTOV.js',
    'chunks/chunk-B3ZFUGTC.js',
    'chunks/chunk-GGVWG4SI.js',
  ].includes(file)) return renameProductLanguage(text)
  if (file === 'chunks/en-SBI6QJ2J.js' || file === 'locales/en.js') {
    const expected = text.split('How is Qwen doing this session? (optional)').length - 1
    if (expected !== 2) throw Error('BCCLI English feedback translation locator changed.')
    return renameProductLanguage(text)
  }
  if (file === 'chunks/server-SJNWHHV4.js') {
    // An additional bundled server/agent instruction uses an upstream product
    // identity. Neutralize only that exact clause; never invent a model name.
    return replaceOnce(text,
      'You are Qwen Code, a general-purpose agentic assistant',
      'You are a general-purpose agentic assistant',
      'server agent product identity')
  }
  if (file === 'chunks/chunk-OYUATJK2.js') {
    const pattern = /var shortAsciiLogo=\x60[\s\S]*?\x60;/
    const matches = text.match(new RegExp(pattern.source, 'g'))
    if (matches?.length !== 1) throw Error('BCCLI branding logo locator changed upstream.')
    return text.replace(pattern, () => 'var shortAsciiLogo=' + String.fromCharCode(96) + BCCLI_ASCII + String.fromCharCode(96) + ';')
  }
  if (file === 'chunks/startInteractiveUI-CECFAXVK.js') {
    let result = replaceOnce(
      text,
      'customBannerTitle?customBannerTitle:">_ Qwen Code"',
      'customBannerTitle?customBannerTitle:">_ BCCLI | BotConnector"',
      'Ink banner title',
    )
    if (result.includes('const versionLabel=formatVersionLabel(version);')) {
      result = replaceOnce(result,
        'const versionLabel=formatVersionLabel(version);',
        'const versionLabel="engine "+formatVersionLabel(version);',
        'Clarify upstream engine version in BCCLI banner')
    }
    result = replaceOnce(result,
      'Add a QWEN.md file to give Qwen Code persistent project context.',
      'Use /help to explore BCCLI tools and commands.',
      'Ink startup tip',
    )
    result = replaceOnce(result,
      'You can resume a previous conversation by running qwen --continue or qwen --resume.',
      'Continue the latest BCCLI session in this project using bccli -c.',
      'Ink resume tip')
    result = replaceOnce(result,
      'You can run any shell commands from Qwen Code using ! (e.g. !ls).',
      'Run terminal commands with ! (e.g. !ls), subject to your permissions.',
      'Ink terminal tip')
    result = replaceOnce(result,
      'qwen --resume ${sessionId}',
      'bccli -c',
      'Ink session-exit command')
    // The upstream feedback popup is not BotConnector's product. It must
    // not be shown or relabeled as a BotConnector-owned feedback service.
    if (result.includes('var FeedbackDialog=__name')) {
      result = replaceOnce(result,
        'var FEEDBACK_DIALOG_KEYS=["1","2","3","0"];var FeedbackDialog=',
        'var FEEDBACK_DIALOG_KEYS=["1","2","3","0"];const BCCLI_DISABLE_UPSTREAM_FEEDBACK=true;var FeedbackDialog=',
        'upstream feedback suppression declaration')
      result = replaceOnce(result,
        'settings.merged.ui?.enableUserFeedback===false||!lastMessageIsAIResponse(history)',
        'settings.merged.ui?.enableUserFeedback===false||BCCLI_DISABLE_UPSTREAM_FEEDBACK||!lastMessageIsAIResponse(history)',
        'upstream feedback suppression guard')
    }
    // The Ink viewport enters the alternate screen and captures scroll/drag
    // events. On Windows, prefer real terminal scrollback and native selection.
    // Users may opt back into the in-app viewport with BCCLI_ENABLE_APP_MOUSE=1.
    result = replaceExactly(result,
      'settings.merged.ui?.useTerminalBuffer',
      'process.platform==="win32"&&process.env.BCCLI_ENABLE_APP_MOUSE!=="1"?false:settings.merged.ui?.useTerminalBuffer',
      3,
      'Ink native scrollback and mouse selection on Windows')
    // Reuse the existing Ink authentication dialog slot for BCCLI's own
    // authenticated provider picker. The upstream AuthDialog would show the
    // wrong provider configuration and cannot switch BCCLI proxy routes.
    const start = result.indexOf('function AuthDialog(){')
    const ending = '__name(AuthDialog,"AuthDialog");'
    const end = result.indexOf(ending, start)
    if (start >= 0 && (end < 0 || result.indexOf(ending, end + ending.length) >= 0)) {
      throw Error('BCCLI arrow-key provider dialog locator changed upstream.')
    }
    if (start >= 0) result = result.slice(0,start) + BCCLI_PROVIDER_DIALOG + result.slice(end)
    result = patchModelDialog(result)
    return renameProductLanguage(result)
  }
  if (file === 'chunks/start-opentui-ui-Q34XCEMN.js') {
    let result = replaceOnce(
      text, 'custom.title??">_ Qwen Code"', 'custom.title??">_ BCCLI | BotConnector"',
      'OpenTUI banner title',
    )
    result = replaceOnce(result,
      'var DEFAULT_GRADIENT=["#4796E4","#847ACE","#C3677F"]',
      'var DEFAULT_GRADIENT='+JSON.stringify(BCCLI_COLORS),
      'OpenTUI default gradient')
    result = replaceOnce(result,
      'addField("Qwen Code",cliVersion',
      'addField("BCCLI engine",cliVersion',
      'OpenTUI diagnostic label')
    result = replaceOnce(result,
      'To continue this session, run qwen --resume ${stats.sessionId}',
      'To resume the latest session in this project, run bccli -c',
      'OpenTUI project-quit resume command')
    result = replaceOnce(result,
      'qwen --resume ${sessionId}',
      'bccli -c',
      'OpenTUI transcript resume command')
    // Windows Terminal should own mouse selection and scrollbar navigation.
    // OpenTUI's alternate screen + mouse reporting otherwise prevents the
    // familiar drag-up-to-select text behavior. Other platforms stay unchanged.
    // Power users can set BCCLI_ENABLE_APP_MOUSE=1 for legacy in-app mouse.
    result = replaceOnce(
      result,
      'useMouse:settings.merged.ui?.mouseTracking!==false',
      'useMouse:process.platform==="win32"?process.env.BCCLI_ENABLE_APP_MOUSE==="1":settings.merged.ui?.mouseTracking!==false,screenMode:process.platform==="win32"&&process.env.BCCLI_ENABLE_APP_MOUSE!=="1"?"main-screen":"alternate-screen"',
      'OpenTUI Windows native mouse selection and screen buffer',
    )
    result = replaceOnce(
      result,
      'mouseTracking:settings.merged.ui?.mouseTracking!==false',
      'mouseTracking:process.platform==="win32"?process.env.BCCLI_ENABLE_APP_MOUSE==="1":settings.merged.ui?.mouseTracking!==false',
      'OpenTUI Windows transcript mouse selection',
    )
    return renameProductLanguage(result)
  }
  if (file === 'chunks/chunk-QUFSNRKR.js') {
    return renameProductLanguage(replaceOnce(text,
      'children:["qwen --resume ",stats.sessionId]',
      'children:["bccli -c (latest session in this project)", ""]',
      'Ink summary session-resume command'))
  }
  if (file === 'chunks/chunk-2PLSL3VQ.js') {
    return replaceOnce(text,
      "To enable automatic tool execution, use the -y flag (YOLO mode):" + String.fromCharCode(10) + "Example: qwen -p 'your prompt' -y",
      "BCCLI requires an interactive approval for this tool. Re-run in interactive mode and approve the tool; unattended auto-approval is disabled.",
      'headless approval warning')
  }
  if (file === 'chunks/chunk-ERV2ECV3.js') {
    let result = text
    if (result.includes('var DEFAULT_BARE_CORE_TOOLS=')) {
      result = replaceOnce(result,
      'var DEFAULT_BARE_CORE_TOOLS=[ToolNames.READ_FILE,ToolNames.EDIT,ToolNames.NOTEBOOK_EDIT,ToolNames.SHELL];',
      'var DEFAULT_BARE_CORE_TOOLS=[ToolNames.READ_FILE,ToolNames.EDIT,ToolNames.NOTEBOOK_EDIT,ToolNames.SHELL,ToolNames.WRITE_FILE,ToolNames.GLOB,ToolNames.GREP,"apply_patch"];',
      'enable safe built-in file create/find/grep under isolated bare mode')
    // Keep compatibility with isolated bare-mode fixtures, while the default
    // BCCLI launcher now uses the full upstream registry.
    // Bare mode has a separate registry branch; updating the core allowlist
    // alone is insufficient. Register the already-vendored implementations.
    result = replaceOnce(result,
      'await registerLazy(ToolNames.SHELL,async()=>{const{ShellTool:ShellTool2}=await import("./shell-MESMTEQS.js");return new ShellTool2(this)});await registerGoalWorkerTools();await registerStructuredOutputIfRequested();',
      'await registerLazy(ToolNames.SHELL,async()=>{const{ShellTool:ShellTool2}=await import("./shell-MESMTEQS.js");return new ShellTool2(this)});await registerLazy(ToolNames.WRITE_FILE,async()=>{const{WriteFileTool}=await import("./write-file-2A6M6WGQ.js");return new WriteFileTool(this)});await registerLazy(ToolNames.GLOB,async()=>{const{GlobTool}=await import("./glob-YYAAZG3O.js");return new GlobTool(this)});await registerLazy(ToolNames.GREP,async()=>{const{GrepTool}=await import("./grep-ZPVNGCCV.js");return new GrepTool(this)});await registerLazy("apply_patch",async()=>{const{ApplyPatchTool}=await import("./bccli-apply-patch-tool.mjs");return new ApplyPatchTool(this)});await registerGoalWorkerTools();await registerStructuredOutputIfRequested();',
      'register missing bare-mode write_file glob and grep_search tool instances')
    }
    // A workspace can define modelProviders with higher priority than CLI
    // --openai-base-url in upstream Qwen Code. In BCCLI, force the OpenAI
    // transport to our localhost proxy and its expiring session token.
    // Other upstream engine features remain untouched.
    if (result.includes('function resolveModelConfig(input){')) {
      result = replaceOnce(result,
        'const apiKeyLayers=[];if(authType&&modelProvider?.envKey)',
        'const apiKeyLayers=[];if(process.env.BCCLI_ACTIVE_PROVIDER&&authType==="openai"){apiKeyLayers.push(envLayer(env,"OPENAI_API_KEY"))}if(authType&&modelProvider?.envKey)',
        'pin BCCLI proxy token ahead of user and project modelProviders')
      result = replaceOnce(result,
        'const baseUrlLayers=[];if(authType&&modelProvider?.baseUrl)',
        'const baseUrlLayers=[];if(process.env.BCCLI_ACTIVE_PROVIDER&&authType==="openai"){baseUrlLayers.push(envLayer(env,"OPENAI_BASE_URL"))}if(authType&&modelProvider?.baseUrl)',
        'pin BCCLI local model API endpoint ahead of project modelProviders')
      result = replaceOnce(result,
        'baseUrl:baseUrlResult?.value,proxy,...generationConfig',
        'baseUrl:baseUrlResult?.value,proxy:process.env.BCCLI_ACTIVE_PROVIDER?void 0:proxy,...generationConfig',
        'prevent project proxy configuration from diverting BCCLI model traffic')
    }
    // When the parent has a separate Brave Search key, expose a provider-
    // neutral web_search backed by its token-gated local search proxy.
    // Otherwise retain upstream DashScope search behavior unchanged.
    if (result.includes('await registerLazy(ToolNames.WEB_FETCH,async()=>')) {
      result = replaceOnce(result,
        'const hasExplicitWebSearchBackend=',
        'if(process.env.BCCLI_WEB_SEARCH_AVAILABLE==="1"&&this.webSearchSettings?.enabled!==false){await registerLazy("web_search",async()=>{const{BccliWebSearchTool}=await import("./bccli-web-search-tool.mjs");return new BccliWebSearchTool()})}const hasExplicitWebSearchBackend=',
        'register provider-neutral BCCLI web search tool')
      result = replaceOnce(result,
        'if(!this.getBareMode()&&!this.isSafeMode()&&this.webSearchSettings?.enabled!==false',
        'if(process.env.BCCLI_WEB_SEARCH_AVAILABLE!=="1"&&!this.getBareMode()&&!this.isSafeMode()&&this.webSearchSettings?.enabled!==false',
        'avoid duplicate upstream DashScope web search when BCCLI search is active')
    }
    // In full mode all upstream tools stay available. Also register the BCCLI
    // read-before-patch tool alongside the upstream file and shell tools.
    if (result.includes('await registerLazy(ToolNames.REPORT_FINDINGS,async()=>')) {
      result = replaceOnce(result,
        'await registerLazy(ToolNames.REPORT_FINDINGS,async()=>{const{ReportFindingsTool}=await import("./report-findings-W4ARGZWM.js");return new ReportFindingsTool});',
        'await registerLazy("apply_patch",async()=>{const{ApplyPatchTool}=await import("./bccli-apply-patch-tool.mjs");return new ApplyPatchTool(this)});await registerLazy(ToolNames.REPORT_FINDINGS,async()=>{const{ReportFindingsTool}=await import("./report-findings-W4ARGZWM.js");return new ReportFindingsTool});',
        'register BCCLI atomic apply_patch in full engine mode')
    }
    return renameProductLanguage(replaceExactly(result,
      'Qwen Code requires permission to use ',
      'BCCLI requires permission to use ', 4,
      'user-facing tool permission errors'))
  }
  if (file === 'chunks/chunk-OV3EBH6J.js') {
    return replaceOnce(text,
      'You are Qwen Code, ${role} developed by Alibaba Group, ${focus}.',
      'You are an AI coding assistant, ${role}, ${focus}.',
      'neutral core agent introduction')
  }
  if (file === 'chunks/chunk-W3YCOEIP.js') {
    let result = replaceExactly(
      text,
      'GradientColors:["#4796E4","#847ACE","#C3677F"]',
      'GradientColors:'+JSON.stringify(BCCLI_COLORS), 2,
      'Ink light/dark gradient')
    result = replaceOnce(result,'AccentPurple:"#8B5CF6"','AccentPurple:"#047857"','light brand accent')
    result = replaceOnce(result,'AccentPurple:"#CBA6F7"','AccentPurple:"#34D399"','dark brand accent')
    result = replaceOnce(result,'AccentBlue:"#3B82F6"','AccentBlue:"#0891B2"','light focus blue')
    return replaceOnce(result,'AccentBlue:"#89B4FA"','AccentBlue:"#22D3EE"','dark focus cyan')
  }
  if (file === 'chunks/chunk-7L4WTOM2.js') {
    let result = replaceOnce(text,
      'https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml&title={title}&info={info}',
      'https://github.com/farijarifriyanto-debug/bccli/issues/new?title={title}&body={info}',
      'user-facing /bug report link')
    result = replaceOnce(result,
      'You are Qwen Code, an interactive CLI agent.',
      'You are an AI coding assistant operating in a terminal.',
      'neutral project initialization prompt')
    result = guardUpstreamProviderCommands(result)
    // Test snippets may omit /init; full pinned engine has it.
    if (result.includes('var initCommand=')) {
      result = replaceOnce(result,
        'Analyzes the project and creates a tailored QWEN.md file.',
        'Analyzes the project and creates an AGENTS.md instruction file.',
        '/init project instruction file description')
      result = replaceOnce(result,
        'Successfully added QWEN.md files from the following directories if there are:',
        'Successfully loaded project instruction files from the following directories:',
        'instruction file refresh message')
    }
    result = replaceOnce(result,
      'get description(){return t("for help on Qwen Code")}',
      'get description(){return t("BCCLI help and keyboard shortcuts")}',
      'Help command description')
    return renameProductLanguage(result)
  }
  throw Error('Unrecognized BCCLI branding file.')
}

function assertSource(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (metadata.name !== '@qwen-code/qwen-code' || metadata.version !== VERSION) {
    throw Error('BCCLI branding needs the pinned Qwen Code engine ' + VERSION + '.')
  }
  const patched = {}
  for (const [relative, expected] of Object.entries(SOURCE_HASHES)) {
    const original = readFileSync(join(packageDir, relative))
    if (digest(original) !== expected) {
      throw Error('Qwen Code view bundle changed: aborting BCCLI branded startup (' + relative + ').')
    }
    patched[relative] = patchUiChunk(relative, original.toString('utf8'))
  }
  return patched
}

function validCache(target, manifest) {
  if (!existsSync(join(target, '.bccli-brand-marker.json'))) return false
  try {
    const stored = JSON.parse(readFileSync(join(target, '.bccli-brand-marker.json'), 'utf8'))
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) return false
    for (const [relative, hash] of Object.entries(manifest.outputHashes)) {
      if (digest(readFileSync(join(target, relative))) !== hash) return false
    }
    return existsSync(join(target, 'cli-entry.js'))
  } catch { return false }
}

/**
 * Make an isolated, revision-pinned white-label copy of the upstream package.
 * UI and the narrowly scoped BCCLI transport/tool safety overrides are modified
 * only in the integrity-verified isolated copy; upstream npm bytes stay unchanged.
 * The source node_modules/@qwen-code/qwen-code package remains byte-identical.
 */
export function prepareBrandedQwen(entrypoint, { cacheRoot } = {}) {
  const packageDir = dirname(entrypoint)
  // Keep the copy within the same npm dependency tree so Node resolves native
  // and bundled imports exactly as the installed upstream runtime does.
  cacheRoot ??= join(homedir(), '.bccli-preview', 'branded-engines')
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const patched = {
    ...assertSource(packageDir),
    'chunks/bccli-atomic-patch.mjs': readFileSync(join(sourceDir, 'atomic-patch.mjs'), 'utf8'),
    'chunks/bccli-apply-patch-tool.mjs': readFileSync(join(sourceDir, 'apply-patch-tool.mjs'), 'utf8'),
    'chunks/bccli-web-search-tool.mjs': readFileSync(join(sourceDir, 'web-search-tool.mjs'), 'utf8'),
  }
  const outputHashes = Object.fromEntries(Object.entries(patched).map(([file, value]) => [file, digest(value)]))
  const manifest = { revision: BRAND_REVISION, version: VERSION, sourceHashes: SOURCE_HASHES, outputHashes }
  const target = join(cacheRoot, VERSION + '-' + digest(JSON.stringify(manifest)).slice(0,12))
  if (existsSync(target)) {
    if (!validCache(target, manifest)) throw Error('BCCLI branded engine cache differs from the pinned build; manual cleanup required.')
    return join(target, basename(entrypoint))
  }
  mkdirSync(cacheRoot, { recursive: true })
  const tmp = mkdtempSync(join(cacheRoot, '.building-'))
  try {
    cpSync(packageDir, tmp, { recursive: true, errorOnExist: false })
    for (const [relative, output] of Object.entries(patched)) {
      writeFileSync(join(tmp, relative), output, 'utf8')
    }
    writeFileSync(join(tmp, '.bccli-brand-marker.json'), JSON.stringify(manifest), 'utf8')
    try { renameSync(tmp, target) }
    catch (err) {
      if (!validCache(target, manifest)) throw err
    }
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  }
  if (!validCache(target, manifest)) throw Error('BCCLI branded engine copy failed verification.')
  return join(target, basename(entrypoint))
}
