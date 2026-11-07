import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { botConnectorKey, botConnectorCredentialStatus } from '../credentials.mjs'

test('reuse existing bc-cloud login from trusted BCCLI home, never from project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'bccli-login-test-'))
  try {
    const credential = join(root, 'credentials')
    writeFileSync(credential, JSON.stringify({ 'bc-cloud': 'FAKE_EXISTING_KEY', 'another-provider': 'NOT_USED' }))
    assert.equal(botConnectorKey({ env: { BCCLI_HOME: root }, home: root }), 'FAKE_EXISTING_KEY')
    assert.equal(botConnectorKey({ env: { BCCLI_HOME: root, BOTCONNECTOR_API_KEY: 'FAKE_ENV_OVERRIDE' }, home: root }), 'FAKE_ENV_OVERRIDE')
    assert.throws(() => botConnectorKey({ env: { BCCLI_HOME: root + '/absent' }, home: root }), /No BotConnector login/)
    writeFileSync(credential, JSON.stringify({ 'qwencloud': 'FAKE_OTHER_PROVIDER' }))
    assert.throws(() => botConnectorKey({ env: { BCCLI_HOME: root }, home: root }), /No bc-cloud key/)
    writeFileSync(credential, 'not JSON')
    assert.throws(() => botConnectorKey({ env: { BCCLI_HOME: root }, home: root }), /not valid JSON/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reject symlinked credential file and relative override', () => {
  const root = mkdtempSync(join(tmpdir(), 'bccli-login-symlink-'))
  try {
    const real = join(root, 'real.json')
    writeFileSync(real, JSON.stringify({ 'bc-cloud': 'FAKE_KEY' }))
    assert.throws(() => botConnectorKey({ env: { BCCLI_HOME: 'project-relative' } }), /absolute/)
    try {
      symlinkSync(real, join(root, 'credentials'))
      assert.throws(() => botConnectorKey({ env: { BCCLI_HOME: root } }), /Invalid BCCLI credentials/)
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('credential status is offline, read-only, and never exposes the long-lived secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'bccli-auth-status-'))
  try {
    const statusMissing = botConnectorCredentialStatus({env:{BCCLI_HOME:root},home:root})
    assert.equal(statusMissing.configured,false)
    assert.equal(statusMissing.source,'none')
    assert.ok(!JSON.stringify(statusMissing).includes('SENSITIVE_FAKE_KEY'))
    const file=join(root,'credentials')
    writeFileSync(file,JSON.stringify({'bc-cloud':'SENSITIVE_FAKE_KEY','unrelated':'OTHER_SECRET'}))
    const saved=botConnectorCredentialStatus({env:{BCCLI_HOME:root},home:root})
    assert.deepEqual(saved,{configured:true,source:'public-bccli'})
    const explicit=botConnectorCredentialStatus({env:{BCCLI_HOME:root,BOTCONNECTOR_API_KEY:'OVERRIDE_FAKE_SECRET'},home:root})
    assert.deepEqual(explicit,{configured:true,source:'environment'})
    assert.ok(!JSON.stringify({saved,explicit}).includes('SENSITIVE_FAKE_KEY'))
    assert.ok(!JSON.stringify({saved,explicit}).includes('OVERRIDE_FAKE_SECRET'))
    assert.equal(botConnectorKey({env:{BCCLI_HOME:root},home:root}),'SENSITIVE_FAKE_KEY')
    // Invalid credential file never masquerades as a valid login.
    writeFileSync(file,'invalid json')
    assert.equal(botConnectorCredentialStatus({env:{BCCLI_HOME:root},home:root}).configured,false)
  } finally { rmSync(root,{recursive:true,force:true}) }
})

test('a credential file readable by other accounts still works but warns without printing the key', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'bccli-login-perms-'))
  const originalWrite = process.stderr.write.bind(process.stderr)
  const warnings = []
  process.stderr.write = (chunk) => { warnings.push(String(chunk)); return true }
  try {
    const file = join(root, 'credentials')
    writeFileSync(file, JSON.stringify({ 'bc-cloud': 'LOOSE_PERMS_FAKE_KEY' }))
    chmodSync(file, 0o644)
    assert.equal(botConnectorKey({ env: { BCCLI_HOME: root }, home: root }), 'LOOSE_PERMS_FAKE_KEY')
    assert.ok(warnings.some(line => line.includes('chmod 600')))
    assert.ok(!warnings.join('').includes('LOOSE_PERMS_FAKE_KEY'))
    warnings.length = 0
    chmodSync(file, 0o600)
    assert.equal(botConnectorKey({ env: { BCCLI_HOME: root }, home: root }), 'LOOSE_PERMS_FAKE_KEY')
    assert.equal(warnings.length, 0)
  } finally {
    process.stderr.write = originalWrite
    rmSync(root, { recursive: true, force: true })
  }
})
