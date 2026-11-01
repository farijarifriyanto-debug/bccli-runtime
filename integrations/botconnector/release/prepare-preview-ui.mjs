#!/usr/bin/env node
// Build one self-contained BCCLI package with the new default coding runtime
// plus the original BCCLI SDK/legacy-command compatibility layer.
// The legacy npm artifact is integrity-pinned; no user files are read or changed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawArgs = process.argv.slice(2)
const IS_STABLE_RELEASE = rawArgs.at(-1) === '--release'
const VERSION = IS_STABLE_RELEASE ? '0.5.7' : '0.5.7-rc.1'
const ENGINE = '@qwen-code/qwen-code@0.26.3'
const PINNED_ENGINE_SHA512 = 'sha512-z8dL1+N2eI1RwQm/tceJmFbxPtdin4TKpFucoau8Nl4bm/DsXsohQLFPM45t20sVzAaYg8aH8qLpX5RCIiXE3A=='
const LEGACY = '@botconnector/bccli@0.4.17'
const PINNED_LEGACY_SHA512 = 'sha512-0LqRhABBHTJKL7XLN9ZqHOWfiFx/iib6UjnwvGPeKPrtcE9iLxtkwhmsj6Qr7PnZVmIw57lwT5IvlzvYz6CIPg=='
if (rawArgs.length !== 0 && !(rawArgs.length === 2 && rawArgs[0] === '--out' && rawArgs[1]) &&
    !(rawArgs.length === 3 && rawArgs[0] === '--out' && rawArgs[1] && rawArgs[2] === '--release')) {
  throw Error('Usage: node prepare-preview-ui.mjs [--out UNIQUE_DIRECTORY] [--release]')
}
const source = fileURLToPath(new URL('../candidate/', import.meta.url))
const dest = resolve(rawArgs[1] || join(tmpdir(), 'bccli-new-ui-preview-' + VERSION))
if (existsSync(dest)) throw Error('Refusing to overwrite an existing build directory.')
const pkgSource = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
assert.equal(pkgSource.dependencies['@qwen-code/qwen-code'], '0.26.3')
assert.equal(pkgSource.private, true)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
const run = (command, args, opts = {}) => {
  const response = spawnSync(command, args, {
    cwd: opts.cwd || dest, encoding: 'utf8', windowsHide: true,
    timeout: opts.timeout || 120000, maxBuffer: 3 * 1024 * 1024,
    shell: process.platform === 'win32' && command === npm,
  })
  if (response.status !== 0 || response.error) {
    throw Error('Release dependency or package step failed (' + command + ', exit=' + response.status + '): ' + (response.stderr || '').slice(0,1200))
  }
  return response.stdout
}

mkdirSync(dest, { recursive: true })
const work = join(dest, '.build-legacy')
mkdirSync(work)
const packed = JSON.parse(run(npm, ['pack', LEGACY, '--json', '--ignore-scripts', '--pack-destination', work], {timeout:120000}))[0]
assert.equal(packed.name, '@botconnector/bccli')
assert.equal(packed.version, '0.4.17')
const archive = join(work, packed.filename)
assert.ok(existsSync(archive))
const observed = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')
assert.equal(observed, PINNED_LEGACY_SHA512, 'Published BCCLI 0.4.17 tarball integrity changed')
run(tar, ['-xzf', archive, '-C', work])
const extracted = join(work, 'package')
const legacyPackage = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
assert.equal(legacyPackage.version, '0.4.17')
assert.ok(existsSync(join(extracted, 'dist', 'sdk.js')))
assert.ok(existsSync(join(extracted, 'dist', 'sdk.d.ts')))
assert.ok(existsSync(join(extracted, 'dist', 'cli.js')))
assert.ok(existsSync(join(extracted, 'LICENSE')))

const files = [
  'LICENSE','THIRD_PARTY_NOTICES.md','cli.mjs','bccli-bootstrap.cjs','session-settings.mjs','core.mjs','proxy.mjs','openai-responses.mjs',
  'gateway.mjs','branding.mjs','credentials.mjs','dialog-models.mjs','model-dialog.mjs',
  'providers.mjs','provider-cli.mjs','startup-menu.mjs','legacy-compat.mjs', 'provider-command.mjs', 'native-key-dialog.mjs', 'provider-dialog.mjs',
  'atomic-patch.mjs', 'apply-patch-tool.mjs', 'web-search-backend.mjs', 'web-search-tool.mjs',
]
for (const file of files) {
  assert.ok(existsSync(join(source, file)), 'Required BCCLI file missing: ' + file)
  cpSync(join(source, file), join(dest, file))
}
cpSync(extracted, join(dest, 'legacy'), { recursive: true })
// Vendor the unmodified upstream npm archive (Apache-2.0) without declaring a
// Qwen npm dependency. npm will therefore not install the optional audio hook.
// Preserve original package.json, copyright, license and all upstream files.
const enginePacked = JSON.parse(run(npm, ['pack', ENGINE, '--json', '--ignore-scripts', '--pack-destination', work], { timeout: 180000 }))[0]
assert.equal(enginePacked.name, '@qwen-code/qwen-code')
assert.equal(enginePacked.version, '0.26.3')
const engineArchive = join(work, enginePacked.filename)
const engineIntegrity = 'sha512-' + createHash('sha512').update(readFileSync(engineArchive)).digest('base64')
assert.equal(engineIntegrity, PINNED_ENGINE_SHA512, 'Upstream engine archive integrity mismatch')
const engineTarget = join(dest, 'engine')
mkdirSync(engineTarget, { recursive: true })
run(tar, ['-xzf', engineArchive, '-C', engineTarget, '--strip-components', '1'], { timeout: 180000 })
assert.ok(existsSync(join(engineTarget, 'LICENSE')))
assert.ok(existsSync(join(engineTarget, 'cli-entry.js')))
const enginePkg = JSON.parse(readFileSync(join(engineTarget, 'package.json'), 'utf8'))
assert.equal(enginePkg.name, '@qwen-code/qwen-code')
assert.equal(enginePkg.version, '0.26.3')
assert.equal(Object.keys(enginePkg.dependencies || {}).length, 0, 'Engine declares extra npm runtime dependencies; cannot safely bundle')
rmSync(work, { recursive: true, force: true })

const pkg = {
  ...pkgSource,
  name: '@botconnector/bccli',
  version: VERSION,
  private: false,
  description: IS_STABLE_RELEASE
    ? 'BCCLI | Full coding engine and legacy SDK with verified Apache-2.0 bundled runtime'
    : 'BCCLI preview | New terminal UI with integrity-pinned Apache-2.0 engine and no @qwen-code npm dependency',
  bin: { bccli: './bccli-bootstrap.cjs' },
  main: './legacy/dist/sdk.js',
  types: './legacy/dist/sdk.d.ts',
  exports: { '.': { types: './legacy/dist/sdk.d.ts', default: './legacy/dist/sdk.js' } },
  dependencies: { ...legacyPackage.dependencies },
  overrides: { ...legacyPackage.overrides, ...pkgSource.overrides },
  files: [...files, 'legacy', 'engine'],
  // npm publication remains an independent, authenticated release operation.
  publishConfig: { access: 'public', tag: IS_STABLE_RELEASE ? 'latest' : 'next' },
}
delete pkg.private
assert.ok(!Object.keys(pkg.dependencies).some(name => name.startsWith('@qwen-code/')), 'Qwen dependency must not reach npm registry')
delete pkg.optionalDependencies
writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
run(process.execPath, ['--check', join(dest, 'cli.mjs')])
run(process.execPath, ['--check', join(dest, 'bccli-bootstrap.cjs')])
run(process.execPath, ['--check', join(dest, 'session-settings.mjs')])
run(process.execPath, ['--check', join(dest, 'legacy-compat.mjs')])
const result = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--no-audit'], {timeout:60000}))[0]
assert.equal(result.name, '@botconnector/bccli')
assert.equal(result.version, VERSION)
const paths = new Set(result.files.map(f => f.path))
for (const expected of [...files, 'legacy/dist/cli.js', 'legacy/dist/sdk.js', 'legacy/dist/sdk.d.ts', 'legacy/LICENSE', 'engine/LICENSE', 'engine/cli-entry.js', 'engine/package.json']) {
  assert.ok(paths.has(expected), 'Pack omitted: ' + expected)
}
for (const item of paths) {
  assert.ok(!/(^|\/)(?:\.env|node_modules|provider-[^/]*\.dpapi|active-provider|sessions-)/.test(item), 'Potential user secrets in package: ' + item)
}
const tgz = join(dest, result.filename)
const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex')
writeFileSync(join(dest, 'SHA256SUMS.txt'), sum + '  ' + result.filename + '\n')
console.log(JSON.stringify({
  status: 'PASS', version: VERSION, name: pkg.name,
  legacySDK: true, legacyCommands: true, pinnedLegacyIntegrity: true, pinnedEngineIntegrity: true, noQwenNpmDependency: true,
  artifact: tgz, files: paths.size, sha256: sum, published: false,
}, null, 2))
