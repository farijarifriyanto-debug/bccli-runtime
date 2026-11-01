import assert from 'node:assert/strict'
import test from 'node:test'
import { patchUiChunk } from '../branding.mjs'

test('white-label patch changes only the ASCII logo with strict locator', () => {
  const original = 'prefix var shortAsciiLogo=' + String.fromCharCode(96) + 'QWEN' + String.fromCharCode(96) + '; suffix'
  const output = patchUiChunk('chunks/chunk-OYUATJK2.js', original)
  assert.ok(output.includes('██████'), 'BCCLI logo must render')
  assert.ok(!output.includes('QWEN'))
  assert.ok(output.startsWith('prefix '))
  assert.ok(output.endsWith(' suffix'))
  assert.throws(() => patchUiChunk('chunks/chunk-OYUATJK2.js', 'x'), /locator changed/)
})

test('Ink and OpenTUI titles update without modifying non-brand fields', () => {
  const session = String.fromCharCode(36) + '{sessionId}'
  const statsSession = String.fromCharCode(36) + '{stats.sessionId}'
  const ink = 'prefix customBannerTitle?customBannerTitle:">_ Qwen Code" Add a QWEN.md file to give Qwen Code persistent project context. You can resume a previous conversation by running qwen --continue or qwen --resume. You can run any shell commands from Qwen Code using ! (e.g. !ls). qwen --resume ' + session + ' suffix' + ' settings.merged.ui?.useTerminalBuffer settings.merged.ui?.useTerminalBuffer settings.merged.ui?.useTerminalBuffer' + ' function ModelDialog({onClose}){return 1}__name(ModelDialog,"ModelDialog");'
  const result = patchUiChunk('chunks/startInteractiveUI-CECFAXVK.js', ink)
  assert.match(result, />_ BCCLI \| BotConnector/)
  assert.match(result, /Use \/help to explore BCCLI/)
  assert.match(result, /Continue the latest BCCLI session in this project using bccli -c/)
  assert.ok(!result.includes('Qwen Code'))
  assert.equal((result.match(/BCCLI_ENABLE_APP_MOUSE/g)||[]).length,3)
  const openTuiBefore = 'custom.title??">_ Qwen Code";var DEFAULT_GRADIENT=["#4796E4","#847ACE","#C3677F"];addField("Qwen Code",cliVersion' + ' To continue this session, run qwen --resume ' + statsSession + ' qwen --resume ' + session + ' useMouse:settings.merged.ui?.mouseTracking!==false mouseTracking:settings.merged.ui?.mouseTracking!==false'
  const openTuiAfter = patchUiChunk('chunks/start-opentui-ui-Q34XCEMN.js', openTuiBefore)
  assert.ok(openTuiAfter.includes('custom.title??">_ BCCLI | BotConnector"'))
  assert.ok(openTuiAfter.includes('var DEFAULT_GRADIENT=["#00AFA0","#22C55E","#EAB308"]'))
  assert.ok(openTuiAfter.includes('addField("BCCLI engine",cliVersion'))
  assert.match(openTuiAfter, /screenMode:process.platform==="win32"/)
  assert.match(openTuiAfter, /useMouse:process.platform==="win32"/)
  assert.match(openTuiAfter, /mouseTracking:process.platform==="win32"/)
  assert.match(openTuiAfter, /BCCLI_ENABLE_APP_MOUSE/)
  assert.ok(!openTuiAfter.includes('qwen --resume'))
  assert.ok(openTuiAfter.includes('To resume the latest session in this project, run bccli -c'))
  assert.ok(result.includes('bccli -c'))
  assert.ok(!result.includes('You can run any shell commands from Qwen Code'))
  const summary = patchUiChunk('chunks/chunk-QUFSNRKR.js','children:["qwen --resume ",stats.sessionId]')
  assert.ok(summary.includes('bccli -c (latest session in this project)'))
  assert.throws(() => patchUiChunk('chunks/startInteractiveUI-CECFAXVK.js', 'different'), /unsupported/)
})

test('server/agent identity copy stays neutral, strict, and does not impersonate the selected AI', () => {
  const original = 'prefix var DEFAULT_INSTRUCTIONS=`## Identity, tone, and role You are Qwen Code, a general-purpose agentic assistant that helps the user complete tasks.` suffix'
  const patched = patchUiChunk('chunks/server-SJNWHHV4.js', original)
  assert.match(patched, /You are a general-purpose agentic assistant/)
  assert.doesNotMatch(patched, /You are Qwen Code/)
  assert.doesNotMatch(patched, /You are BCCLI/)
  assert.ok(patched.startsWith('prefix '))
  assert.ok(patched.endsWith(' suffix'))
  assert.throws(() => patchUiChunk('chunks/server-SJNWHHV4.js', 'upstream changed'), /unsupported/)
})

test('quota classifier fast-fails weekly and monthly usage-limit 429s', () => {
  const original = 'prefix function isQuotaExhaustedError(error){const message=getQuotaMessage(error);if(!message)return false;const lower=message.toLowerCase();return lower.includes("quota")&&(lower.includes("exhausted")||lower.includes("exceeded"))&&(lower.includes("will reset")||lower.includes("reset at"))} suffix'
  const patched = patchUiChunk('chunks/chunk-NCVLAQE5.js', original)
  assert.ok(patched.includes('lower.includes("quota")&&(lower.includes("exhausted")||lower.includes("exceeded"))&&(lower.includes("will reset")||lower.includes("reset at"))'), 'existing quota condition must stay intact')
  assert.ok(patched.includes('||lower.includes("weekly usage limit")||lower.includes("monthly usage limit")'), 'weekly/monthly usage limits must classify as quota exhaustion')
  assert.ok(patched.startsWith('prefix '))
  assert.ok(patched.endsWith(' suffix'))
  assert.throws(() => patchUiChunk('chunks/chunk-NCVLAQE5.js', 'upstream changed'), /unsupported/)
})
