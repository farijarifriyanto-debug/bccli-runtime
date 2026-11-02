import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_FILES } from '../../release/runtime-files.mjs'

// A module the CLI imports but the packer never copies ships a package that
// cannot start. Both packers build their file list from RUNTIME_FILES, so the
// list is what this test holds to the CLI's real import graph.
const source = fileURLToPath(new URL('..', import.meta.url))
const shipped = new Set(RUNTIME_FILES)

function modulesReachableFrom(entry) {
  const seen = new Set()
  const queue = [entry]
  const pattern = /(?:from|import)\s*['"](\.[^'"]+)['"]/g
  while (queue.length) {
    const file = queue.pop()
    const name = path.relative(source, file)
    if (seen.has(name)) continue
    seen.add(name)
    const text = readFileSync(file, 'utf8')
    let match
    pattern.lastIndex = 0
    while ((match = pattern.exec(text))) {
      const target = path.resolve(path.dirname(file), match[1])
      const relative = path.relative(source, target)
      if (relative.endsWith('.mjs') || relative.endsWith('.cjs')) queue.push(target)
    }
  }
  return seen
}

test('the packaged runtime covers every module the CLI imports', () => {
  for (const module of modulesReachableFrom(path.join(source, 'cli.mjs'))) {
    assert.ok(shipped.has(module), 'runtime-files.mjs omits a module the CLI imports: ' + module)
  }
})

test('runtime-files.mjs lists files that exist in the candidate source', () => {
  for (const file of RUNTIME_FILES) {
    assert.ok(readFileSync(path.join(source, file)), 'runtime-files.mjs lists a missing file: ' + file)
  }
})
