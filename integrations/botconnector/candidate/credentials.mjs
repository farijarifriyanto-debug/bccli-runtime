// Credentials bridge: reuse an owner's existing BCCLI bc-cloud login without
// another provider account or a second credential store. Never log the key.
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { lstatSync, readFileSync } from 'node:fs'

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024

export function botConnectorKey({ env = process.env, home = homedir() } = {}) {
  if (typeof env.BOTCONNECTOR_API_KEY === 'string' && env.BOTCONNECTOR_API_KEY.trim()) {
    return env.BOTCONNECTOR_API_KEY.trim()
  }
  const override = env.BCCLI_HOME
  const base = override ? override : join(home, '.bccli')
  if (!isAbsolute(base)) throw Error('BCCLI_HOME must be an absolute directory.')
  const path = join(base, 'credentials')
  let info
  try { info = lstatSync(path) }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw Error('No BotConnector login. Run bccli login to save your bc-cloud key, or set BOTCONNECTOR_API_KEY.')
    }
    throw Error('Cannot inspect the existing BCCLI credentials file.')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw Error('Invalid BCCLI credentials file; do not follow symlinks or oversized files.')
  }
  // The legacy CLI stores this key as plaintext JSON; the best the reader can
  // do is refuse silence about a file other accounts can read. POSIX only:
  // Windows ACLs cannot be inspected portably here (and the separate DPAPI
  // store already covers the new providers). Never fail on this - the file
  // was written by the 0.4.x CLI the owner chose to run.
  if (process.platform !== 'win32') {
    const looseMode = (info.mode & 0o077) !== 0
    const wrongOwner = typeof process.getuid === 'function' && info.uid !== process.getuid()
    if (looseMode || wrongOwner) {
      process.stderr.write('BCCLI: warning: ' + path + ' can be read by other accounts on this machine; consider chmod 600. The key itself was not printed.\n')
    }
  }
  let data
  try { data = JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw Error('Existing BCCLI credentials are not valid JSON.') }
  const key = data && typeof data === 'object' && !Array.isArray(data) ? data['bc-cloud'] : null
  if (typeof key !== 'string' || !key.trim()) {
    throw Error('No bc-cloud key saved. Run bccli login or set BOTCONNECTOR_API_KEY.')
  }
  return key.trim()
}

/**
 * Offline, read-only status. Reuse the public BCCLI bc-cloud login; never
 * duplicate, rewrite, mask-print, or migrate the long-lived secret.
 * "configured" means a credential exists, not that Gateway accepted it.
 */
export function botConnectorCredentialStatus({ env = process.env, home = homedir() } = {}) {
  const viaEnvironment = typeof env.BOTCONNECTOR_API_KEY === 'string' && !!env.BOTCONNECTOR_API_KEY.trim()
  try {
    botConnectorKey({ env, home })
    return { configured: true, source: viaEnvironment ? 'environment' : 'public-bccli' }
  } catch (error) {
    // All botConnectorKey errors are intentionally static; do not include keys.
    return { configured: false, source: 'none', reason: error instanceof Error ? error.message : 'Credential inspection failed.' }
  }
}
