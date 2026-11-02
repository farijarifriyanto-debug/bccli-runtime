#!/usr/bin/env node
// Offline, no-publish BCCLI prerelease tarball builder.
// Never edits the installed engine, stable npm package, or user credential files.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_FILES } from './runtime-files.mjs'

const args = process.argv.slice(2)
function option(name, fallback) {
  const pos = args.indexOf(name)
  return pos < 0 ? fallback : args[pos + 1]
}
for (const arg of args) {
  if (arg.startsWith('-') && !['--source', '--out'].includes(arg)) {
    throw Error('Supported flags: --source DIRECTORY --out DIRECTORY')
  }
}
const RELEASE_VERSION = readFileSync(fileURLToPath(new URL('VERSION', import.meta.url)), 'utf8').trim()
if (!/^\d+\.\d+\.\d+$/.test(RELEASE_VERSION)) {
  throw Error('release/VERSION must be a plain semantic version, got: ' + JSON.stringify(RELEASE_VERSION))
}
const version = RELEASE_VERSION + '-rc.1'
const source = resolve(option('--source', fileURLToPath(new URL('../candidate/', import.meta.url))))
const dest = resolve(option('--out', join(tmpdir(), 'bccli-next-' + version)))
const name = '@botconnector/bccli'
if (!existsSync(join(source, 'package.json'))) throw Error('No candidate source package')
if (existsSync(dest)) throw Error('Output already exists; refuse to overwrite a previous release candidate')
const original = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
assert.equal(original.name, '@botconnector/bccli-preview')
assert.equal(original.version, '0.1.0-rc.3')
assert.equal(original.dependencies['@qwen-code/qwen-code'], '0.26.3')
const files = [...RUNTIME_FILES]
mkdirSync(dest, {recursive:true})
for (const file of files) {
  const path = join(source, file)
  assert.ok(existsSync(path), 'Missing required release file: ' + file)
  cpSync(path, join(dest, file))
}
const pkg = {
  ...original,
  name, version,
  description:'BCCLI | BotConnector multi-provider coding agent',
  bin: {bccli:'./cli.mjs'},
  files,
  publishConfig: {access:'public', tag:'next'},
}
delete pkg.private
writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
assert.equal(spawnSync(process.execPath, ['--check', join(dest, 'cli.mjs')], {encoding:'utf8'}).status, 0)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pack = spawnSync(npm, ['pack','--ignore-scripts','--offline','--json'], {
  cwd:dest, encoding:'utf8', timeout:45000, windowsHide:true, shell:process.platform === 'win32',
  env:{...process.env, npm_config_offline:'true'},
})
if (pack.status !== 0) throw Error('Offline npm pack failed: ' + (pack.stderr || ''))
const output = JSON.parse(pack.stdout)[0]
assert.equal(output.name, name)
assert.equal(output.version, version)
const included = new Set(output.files.map(f => f.path))
for (const file of files) assert.ok(included.has(file), 'Missing in npm tarball: ' + file)
assert.ok(included.has('package.json'))
assert.ok(![...included].some(f => /(?:^|\/)(?:node_modules|\.env|sessions-|provider-.*\.dpapi)/.test(f)))
const artifact = join(dest, output.filename)
assert.ok(existsSync(artifact), 'Archive missing after pack')
console.log(JSON.stringify({
  status:'PASS', package:name, version, bin:'bccli', tag:'next',
  files:included.size, artifact, published:false,
}, null, 2))
