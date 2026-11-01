// In-terminal BCCLI first-run / provider-switch menu.
// This runs in the parent process BEFORE the coding agent is launched; real
// API keys never enter Qwen's process or any coding/MCP subprocess.
import { createInterface } from 'node:readline/promises'
import { PROVIDERS, listProviderDefinitions, providerDefinition, isConfigured, resolveProvider, selectedProvider, selectedModel, saveSelectedModel, saveProviderKey, useProvider } from './providers.mjs'
import { hiddenApiKey } from './provider-cli.mjs'
import { DEFAULT_MODEL, discoverModels, selectModel } from './core.mjs'

export const PROVIDER_SWITCH_EXIT = 51

// Returning users go straight to chat with the selected provider and model.
// Eligibility is still verified against the live provider's available models.
export async function autoSelectStartup({
  providerId = selectedProvider(),
  configured = isConfigured,
  remembered = selectedModel,
  dialogModel = () => undefined,
  resolve = resolveProvider,
  list = discoverModels,
  defaultModel = DEFAULT_MODEL,
  env = process.env,
} = {}) {
  if (!configured(providerId)) return undefined
  // A model chosen in the upstream /model picker is persisted in the engine's
  // per-provider settings; it wins over the older active-model file, but only
  // when the live catalog still offers it.
  const candidates = providerId === 'botconnector'
    ? [env.BOTCONNECTOR_MODEL_ID, dialogModel(providerId), remembered(providerId), defaultModel]
    : [dialogModel(providerId), remembered(providerId)]
  if (!candidates.some(Boolean)) return undefined
  const profile = resolve(providerId)
  const models = await list({ key: profile.key, endpoint: profile.endpoint })
  const requested = candidates.find(id => id && models.some(item => item.id === id))
  if (!requested) return undefined
  return { providerId, model: selectModel(models, requested, providerId), key: profile.key, endpoint: profile.endpoint }
}

export async function terminalQuestion(label, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output, terminal: !!input.isTTY })
  try { return (await rl.question(label)).trim() }
  finally { rl.close() }
}

function selectedName(answer, choices, defaultValue) {
  if (!answer) return defaultValue
  const clean = answer.replace(/!$/, '').trim().toLowerCase()
  if (/^[0-9]+$/.test(clean)) return choices[Number(clean) - 1]
  return choices.includes(clean) ? clean : undefined
}

export async function startupMenu({
  ask = terminalQuestion,
  askSecret = hiddenApiKey,
  out = value => console.log(value),
  currentProvider = selectedProvider,
  configured = isConfigured,
  saveKey = saveProviderKey,
  use = useProvider,
  remembered = selectedModel,
  dialogModel = () => undefined,
  saveModel = saveSelectedModel,
  resolve = resolveProvider,
  list = discoverModels,
  defaultModel = DEFAULT_MODEL,
} = {}) {
  const ids = Object.keys(listProviderDefinitions())
  const active = currentProvider()
  out('')
  out('BCCLI  |  Provider dan model')
  out('Pilih provider. Masukkan tanda ! setelah angka untuk mengganti API key yang sudah tersimpan.')
  ids.forEach((id, idx) => {
    out('  ' + (idx + 1) + '. ' + providerDefinition(id).name +
      (configured(id) ? '  [key tersedia]' : '  [perlu API key]') +
      (id === active ? '  [aktif]' : ''))
  })
  let providerId
  let replace
  for (;;) {
    const value = await ask('Provider (angka/nama; Enter = aktif; Ctrl+C untuk batal): ')
    providerId = selectedName(value, ids, active)
    if (!providerId) { out('Pilihan provider tidak dikenal.'); continue }
    replace = value.endsWith('!')
    break
  }
  let pendingKey
  if (replace || !configured(providerId)) {
    out('Masukkan API key ' + providerDefinition(providerId).name + ' (input tersembunyi).')
    pendingKey = await askSecret()
    if (!pendingKey) throw Error('Tidak ada API key; provider tidak diubah.')
  }
  if (!pendingKey && !configured(providerId)) throw Error('Provider ' + providerId + ' belum memiliki API key. Tidak ada permintaan AI.')
  // Validate before saving so a bad replacement never destroys a working key.
  const profile = pendingKey
    ? { id: providerId, key: pendingKey, endpoint: providerDefinition(providerId).endpoint }
    : resolve(providerId)
  const models = await list({ key: profile.key, endpoint: profile.endpoint })
  if (!models.length) throw Error('Tidak ada model untuk provider ini.')
  const all = [...models].sort((a, b) => a.id.localeCompare(b.id))
  const previous = dialogModel(providerId) ?? remembered(providerId)
  const preferred = all.some(m => m.id === previous) ? previous :
    providerId === 'botconnector' && all.some(m => m.id === defaultModel) ? defaultModel : undefined
  let filtered = all
  for (;;) {
    out('')
    out('Model ' + providerDefinition(providerId).name + ' (' + filtered.length + ' dari ' + all.length + ' model):')
    filtered.slice(0, 14).forEach((m, i) => out('  ' + (i + 1) + '. ' + m.id + (m.id === preferred ? '  [default]' : '')))
    if (filtered.length > 14) out('  ... ketik ?kata untuk mencari model.')
    const value = await ask('Model (nomor/ID/?cari' + (preferred ? '/Enter = ' + preferred : '') + '): ')
    if (value.startsWith('?')) {
      const term = value.slice(1).trim().toLowerCase()
      filtered = term ? all.filter(m => m.id.toLowerCase().includes(term) || m.name?.toLowerCase().includes(term)) : all
      if (!filtered.length) { out('Tidak ada model yang cocok.'); filtered = all }
      continue
    }
    const candidate = !value ? preferred : /^[0-9]+$/.test(value) ? filtered[Number(value) - 1]?.id : value
    if (!candidate || !all.some(m => m.id === candidate)) { out('Pilih nomor atau ID model yang tampil.'); continue }
    selectModel(all, candidate, providerId)
    // Save only after authenticated model discovery and selection.
    if (pendingKey) {
      saveKey(providerId, pendingKey)
      out('API key tersimpan terlindungi. Tidak ada permintaan chat AI.')
    }
    use(providerId)
    saveModel(providerId, candidate)
    return { providerId, model: candidate, key: profile.key, endpoint: profile.endpoint }
  }
}
