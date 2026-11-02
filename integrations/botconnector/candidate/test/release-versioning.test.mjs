import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// The release version is read by the release tooling from release/VERSION; a
// second copy in a script or workflow is the drift this guards against.
const version = readFileSync(new URL('../../release/VERSION', import.meta.url), 'utf8').trim()

test('the release version has exactly one source', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'release/VERSION must be a plain semantic version')
})

test('release tooling never repeats the release version', () => {
  const files = [
    '../../release/prepare-preview-ui.mjs',
    '../../../../.github/workflows/bccli-new-ui-bundled-preview.yml',
  ]
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(!text.includes(version), file + ' must read release/VERSION instead of repeating ' + version)
  }
})
