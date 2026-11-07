import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { GATEWAY } from './gateway.mjs'
import { ALLOWED_PROVIDER_ENDPOINTS, PROVIDERS, listProviderDefinitions, providerDefinition, registerCustomProvider, approvedProviderEndpoint, resolveProvider, isConfigured, useProvider, saveSelectedModel, saveProviderKey, removeProvider } from './providers.mjs'
import { promptProviderKey, confirmRemoveProviderKey, promptCustomProvider } from './native-key-dialog.mjs'
import { searchWithBrave, validateSearchQuery } from './web-search-backend.mjs'
import { RESPONSES_ONLY_REJECTION, REASONING_NONE_UNSUPPORTED, toResponsesRequest, createResponsesChatTranslator, responsesJsonToChat } from './openai-responses.mjs'

// This proxy lives only for one Qwen Code session. Real provider keys remain in
// the launcher process; MCP and bash subprocesses can see only a short-lived
// local bearer token. The proxy cannot be redirected to arbitrary hosts.
const ALLOWED_PATHS = new Set(['/v1/models', '/v1/chat/completions', '/v1/responses'])
const MAX_REQUEST_BYTES = 16 * 1024 * 1024

// Qwen 0.26.3 produces get_goal without parameters and read_file with
// optional JSON-schema type unions such as ["integer", "null"]. Strict
// OpenAI-compatible providers reject both formats while parsing tools.
// Normalize only the incompatible pieces, preserving all coding tools.
function normalizeOptionalNullableSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  let out = schema
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    let properties = schema.properties
    for (const [name, field] of Object.entries(schema.properties)) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue
      let candidate = field
      // The optional absence of a field already represents null; dropping
      // "null" from this one optional JSON-Schema union is safe. Do not rewrite
      // required nullable fields or multi-type unions (fail closed upstream).
      if (!required.has(name) && Array.isArray(field.type) && field.type.length === 2
        && field.type.includes('null')) {
        const primitive = field.type.find((type) => type !== 'null')
        if (['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(primitive)) {
          candidate = { ...field, type: primitive }
        }
      }
      candidate = normalizeOptionalNullableSchema(candidate)
      if (candidate !== field) {
        if (properties === schema.properties) properties = { ...properties }
        properties[name] = candidate
      }
    }
    if (properties !== schema.properties) out = { ...out, properties }
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    const items = normalizeOptionalNullableSchema(schema.items)
    if (items !== schema.items) out = { ...out, items }
  }
  return out
}

export function normalizeZeroArgFunctionTools(requestBody) {
  if (!requestBody || typeof requestBody !== 'object' || !Array.isArray(requestBody.tools)) return requestBody
  let changed = false
  const tools = requestBody.tools.map((tool) => {
    const fn = tool?.type === 'function' ? tool.function : null
    if (!fn || typeof fn.name !== 'string') return tool
    const parameters = fn.parameters == null
      ? { type: 'object', properties: {} }
      : normalizeOptionalNullableSchema(fn.parameters)
    if (parameters === fn.parameters) return tool
    changed = true
    return { ...tool, function: { ...fn, parameters } }
  })
  return changed ? { ...requestBody, tools } : requestBody
}

// The model can be switched with /model without restarting the coding agent.
// Annotate each request with the ACTUAL model chosen by Qwen Config, rather
// than retaining a stale --append-system-prompt model from CLI startup.
export function attachRuntimeModelContext(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.messages)) return payload
  const model = payload.model
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/.test(model)) return payload
  const index = payload.messages.findIndex(item => item?.role === 'system' && typeof item.content === 'string')
  if (index === -1) return payload
  const runtime = '\n\nRuntime metadata (not model instructions): active_model_id=' + model + '; client_app=BCCLI; transport=local-proxy.'
  const messages = [...payload.messages]
  messages[index] = { ...messages[index], content: messages[index].content + runtime }
  return { ...payload, messages }
}

// Qwen 0.26.3 sends max_tokens=64000 for many model IDs. Several Gateway
// upstream routes reject that value (e.g. GLM Flash). Bound the requested
// output conservatively for coding-agent interoperability; never increase it.
// This does not change the context window or input-token budget.
const DEFAULT_OUTPUT_TOKEN_CEILING = 4096
export function boundChatOutputTokens(payload, { endpoint } = {}) {
  if (!payload || typeof payload !== 'object') return payload
  const legacy = payload.max_tokens
  const modern = payload.max_completion_tokens
  const valid = (value) => Number.isInteger(value) && value > 0

  // Real Gateway's exact Kimi route rejects legacy max_tokens. Keep parity
  // with PAYG validation for positive decimal numeric strings, without
  // changing the output-ceiling policy for any other model.
  // OpenAI's own API rejects max_tokens on current models while accepting
  // max_completion_tokens on every model it serves, so match its endpoint
  // rather than a model list that rots with each release.
  if (payload.model === 'kimi-k2.7-code' || endpoint === PROVIDERS.openai.endpoint) {
    const parsed = (value) => {
      if (typeof value !== 'number' && !(typeof value === 'string' && /^[0-9]+$/.test(value))) return null
      const n = Number(value)
      return Number.isSafeInteger(n) && n > 0 ? n : null
    }
    const legacyValue = parsed(legacy)
    const modernValue = parsed(modern)
    if (legacyValue != null) {
      const requested = modernValue != null ? Math.min(legacyValue, modernValue) : legacyValue
      const { max_tokens: _ignored, ...rest } = payload
      return { ...rest, max_completion_tokens: Math.min(requested, DEFAULT_OUTPUT_TOKEN_CEILING) }
    }
    if (modernValue != null && (typeof modern !== 'number' || modernValue > DEFAULT_OUTPUT_TOKEN_CEILING)) {
      return { ...payload, max_completion_tokens: Math.min(modernValue, DEFAULT_OUTPUT_TOKEN_CEILING) }
    }
  }
  if (valid(legacy) && legacy > DEFAULT_OUTPUT_TOKEN_CEILING) {
    return { ...payload, max_tokens: DEFAULT_OUTPUT_TOKEN_CEILING }
  }
  if (valid(modern) && modern > DEFAULT_OUTPUT_TOKEN_CEILING) {
    return { ...payload, max_completion_tokens: DEFAULT_OUTPUT_TOKEN_CEILING }
  }
  return payload
}

// OpenAI refuses function tools together with a nonzero reasoning effort on
// chat/completions, and the same request succeeds with reasoning disabled.
// Which models refuse, and which accept 'none' at all, varies per model and
// changes without notice, so the upstream rejection text is the only signal
// used here; a retry that is rejected too leaves the original explanation
// intact because that is the one that tells the user what to do.
const OPENAI_TOOL_REASONING_REJECTION = /Function tools with reasoning_effort are not supported/
function reasoningDisabledRetryBody(body, errorText) {
  if (!OPENAI_TOOL_REASONING_REJECTION.test(errorText)) return null
  let parsed
  try { parsed = JSON.parse(body.toString('utf8')) }
  catch { return null }
  if (!parsed || typeof parsed !== 'object' || parsed.reasoning_effort === 'none') return null
  return Buffer.from(JSON.stringify({ ...parsed, reasoning_effort: 'none' }))
}

function waitForDrainOrClose(res) {
  if (res.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

function matchesToken(auth, token) {
  if (typeof auth !== 'string') return false
  const actual = Buffer.from(auth)
  const expected = Buffer.from('Bearer ' + token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startGatewayProxy({ key, endpoint = GATEWAY, token = randomBytes(32).toString('hex'), fetchImpl = fetch, liveProvider = false, initialProvider = 'botconnector', resolveProfile = resolveProvider, configured = isConfigured, selectProvider = useProvider, rememberModel = saveSelectedModel, secureKeyPrompt = promptProviderKey, secureRemoveConfirm = confirmRemoveProviderKey, persistKey = saveProviderKey, deleteKey = removeProvider, promptNewProvider = promptCustomProvider, registerNewProvider = registerCustomProvider, searchApiKey = process.env.BRAVE_SEARCH_API_KEY, searchImpl = searchWithBrave, switchLimits = { cooldownMs: 1000, perSession: 20 }, dialogLimits = { cooldownMs: 1000, perSession: 10 } } = {}) {
  if (!approvedProviderEndpoint(endpoint)) throw Error('Unapproved provider endpoint; local proxy refused to start.')
  if (typeof key !== 'string' || !key.trim()) throw Error('Gateway key is required for local proxy.')
  if (typeof token !== 'string' || token.length < 6 || token === key) throw Error('Invalid or non-isolated proxy token.')

  // In-process provider switching keeps the same coding-agent session and
  // approval state. Real keys never leave the parent proxy, and the configured
  // HTTPS endpoint must belong to the audited provider allowlist.
  let active = { id: initialProvider, endpoint, key }
  let inFlight = 0
  // A model proven to answer only on the Responses route goes straight there
  // on later turns instead of paying the refused chat round trips every time.
  const responsesOnlyModels = new Set()
  let managingKeys = false
  let credentialRevoked = false
  let searchesUsed = 0
  // Provider switching and native key dialogs are meant to be initiated by a
  // human at this terminal, but the session token is inherited by every engine
  // subprocess (MCP servers, approved shell commands). A malicious local
  // process could therefore switch providers silently (billing diversion to
  // another configured provider) or spam native key dialogs (social
  // engineering). Keep the operations possible for the user, but bound their
  // rate so unattended abuse stands out, and never gate the AI request path.
  let switchesUsed = 0
  let lastSwitchAt = 0
  const switchGate = () => {
    const now = Date.now()
    if (switchesUsed >= switchLimits.perSession) return 'Session provider-switch limit reached.'
    if (now - lastSwitchAt < switchLimits.cooldownMs) return 'Too soon; wait a moment before switching providers again.'
    lastSwitchAt = now
    switchesUsed += 1
    return null
  }
  let dialogsUsed = 0
  let lastDialogAt = 0
  // Cooldown is short on purpose: it exists to break popup bursts, not to slow
  // a human, who cannot complete one native key dialog in under a second. The
  // per-session cap is the real stopper. Malformed requests are validated
  // before this gate so attackers cannot burn the honest user's dialog budget.
  const dialogGate = () => {
    const now = Date.now()
    if (dialogsUsed >= dialogLimits.perSession) return 'Session provider-dialog limit reached.'
    if (now - lastDialogAt < dialogLimits.cooldownMs) return 'Too soon; wait a moment before opening another provider dialog.'
    lastDialogAt = now
    dialogsUsed += 1
    return null
  }
  const readLocalAction = async (req, max = 512) => {
    const buffers = []
    let length = 0
    for await (const piece of req) {
      length += piece.length
      if (length > max) throw Error('Too much data')
      buffers.push(piece)
    }
    const input = JSON.parse(Buffer.concat(buffers).toString('utf8'))
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.action !== 'user-confirmed-local-key-dialog' ||
        typeof input.provider !== 'string' || !Object.hasOwn(listProviderDefinitions(), input.provider) ||
        Object.keys(input).some(name => name !== 'action' && name !== 'provider')) throw Error('Invalid key-management request')
    return input.provider
  }

  const publicProviders = () => Object.entries(listProviderDefinitions()).map(([id, item]) => ({
    id, name: item.name, active: id === active.id, configured: configured(id),
  }))
  const getModels = async (id) => {
    if (!Object.hasOwn(listProviderDefinitions(), id)) throw Error('Unsupported provider')
    if (!configured(id)) throw Error('Provider is not configured')
    const profile = resolveProfile(id)
    if (!approvedProviderEndpoint(profile.endpoint) || profile.endpoint !== providerDefinition(id).endpoint || !profile.key) {
      throw Error('Unsafe provider profile')
    }
    const upstream = await fetchImpl(profile.endpoint + '/models', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + profile.key, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12000),
    })
    if (!upstream.ok) throw Error('Provider catalog unavailable')
    const body = await upstream.json()
    if (!Array.isArray(body?.data)) throw Error('Invalid catalog')
    const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/
    const ids = [...new Set(body.data.map(x => x?.id).filter(x => typeof x === 'string' && modelId.test(x)))].sort()
    if (!ids.length) throw Error('No eligible models')
    return { profile, models: ids }
  }
  const server = createServer(async (req, res) => {
    const fail = (status, body) => {
      if (res.headersSent || res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: body }))
    }

    if (!matchesToken(req.headers.authorization, token)) {
      fail(401, 'Local session token is required.')
      return
    }
    // Provider management is a local-only, authenticated, explicitly user-
    // invoked slash command. The payload is never forwarded as an AI prompt.
    if (req.url === '/v1/bccli/providers' && liveProvider && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ providers: publicProviders(), active: active.id }))
      return
    }
    if (liveProvider && (req.url === '/v1/bccli/provider/key/add' || req.url === '/v1/bccli/provider/key/remove')) {
      if (req.method !== 'POST') { fail(405, 'Method not allowed.'); return }
      if (inFlight || managingKeys) { fail(409, 'Finish the active operation first.'); return }
      if (Number(req.headers['content-length'] || 0) > 512) { fail(413, 'Invalid key-management request.'); return }
      managingKeys = true
      try {
        const id = await readLocalAction(req)
        const dialogBlock = dialogGate()
        if (dialogBlock) { fail(429, dialogBlock); return }
        if (req.url.endsWith('/add')) {
          // Only the parent launches this masked native Windows dialog. The
          // child sends only the provider ID, never a user-entered API key.
          const proposed = await secureKeyPrompt(id)
          if (proposed == null) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ provider: id, cancelled: true }))
            return
          }
          if (typeof proposed !== 'string' || !proposed.trim() || proposed.length > 8192 || /[\r\n]/.test(proposed)) throw Error('Invalid input')
          const where = providerDefinition(id)
          const upstream = await fetchImpl(where.endpoint + '/models', {
            method: 'GET', headers: { authorization: 'Bearer ' + proposed.trim(), accept: 'application/json' },
            redirect: 'error', signal: AbortSignal.timeout(12000),
          })
          if (!upstream.ok) { fail(400, 'API key was not accepted by provider. Existing key unchanged.'); return }
          const body = await upstream.json()
          if (!Array.isArray(body?.data)) { fail(400, 'Provider returned an invalid model catalog. Existing key unchanged.'); return }
          persistKey(id, proposed.trim())
          if (active.id === id) {
            active = { id, endpoint: where.endpoint, key: proposed.trim() }
            credentialRevoked = false
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ provider: id, saved: true, active: active.id === id }))
        } else {
          // Deleting secrets MUST be a user-confirmed native dialog, not a
          // silent HTTP operation executable by the model's coding tools.
          const confirmed = await secureRemoveConfirm(id)
          if (!confirmed) {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ provider: id, cancelled: true }))
            return
          }
          deleteKey(id)
          if (active.id === id) {
            active = { id, endpoint: active.endpoint, key: null }
            credentialRevoked = true
          }
          const stillConfigured = configured(id)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ provider: id, removed: true, active: active.id === id, stillConfigured }))
        }
      } catch {
        fail(400, 'Unable to manage API key. Existing provider key was not printed.')
      } finally {
        managingKeys = false
      }
      return
    }
    if (liveProvider && req.url === '/v1/bccli/provider/custom/add') {
      if (req.method !== 'POST') { fail(405,'Method not allowed.');return }
      if (inFlight || managingKeys) { fail(409,'Finish the active operation first.');return }
      managingKeys=true
      try {
        const parts=[]
        let bytes=0
        for await (const chunk of req) { bytes+=chunk.length;if(bytes>256)throw Error('Too long');parts.push(chunk) }
        const json=JSON.parse(Buffer.concat(parts).toString('utf8'))
        if (Object.keys(json).length!==1 || json.action!=='user-confirmed-local-custom-provider-dialog') throw Error('Bad action')
        const dialogBlock=dialogGate()
        if (dialogBlock) { fail(429,dialogBlock);return }
        // This operation can only persist details explicitly entered into the
        // local Windows dialog. No URL or credentials are accepted via HTTP.
        const details=await promptNewProvider()
        if (!details) {
          res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
          res.end(JSON.stringify({cancelled:true}))
          return
        }
        const id=details.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32)
        const info=registerNewProvider(id,details.name,details.endpoint)
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
        res.end(JSON.stringify({provider:info.id,name:info.name,endpoint:info.endpoint,added:true}))
      }catch {
        fail(400,'Custom provider could not be registered. Use a unique name and a public HTTPS OpenAI-compatible base URL.')
      }finally{managingKeys=false}
      return
    }
    const modelsMatch = liveProvider && /^\/v1\/bccli\/providers\/([a-z][a-z0-9-]{0,31})\/models$/.exec(req.url ?? '')
    if (modelsMatch && req.method === 'GET') {
      try {
        const { models } = await getModels(modelsMatch[1])
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ provider: modelsMatch[1], models }))
      } catch {
        fail(400, 'Provider is not configured or its model catalog cannot be verified.')
      }
      return
    }
    if (req.url === '/v1/bccli/provider/switch' && liveProvider && req.method === 'POST') {
      if (inFlight || managingKeys) { fail(409, 'Finish the active AI response or key manager before switching providers.'); return }
      if (Number(req.headers['content-length'] || 0) > 1024) { fail(413, 'Invalid provider selection.'); return }
      const switchBlock = switchGate()
      if (switchBlock) { fail(429, switchBlock); return }
      try {
        const buffers = []
        let length = 0
        for await (const part of req) {
          length += part.length
          if (length > 1024) { fail(413, 'Invalid provider selection.'); return }
          buffers.push(part)
        }
        const selection = JSON.parse(Buffer.concat(buffers).toString('utf8'))
        const id = selection?.provider
        const model = selection?.model
        if (selection?.action !== 'user-selected-provider' ||
            typeof id !== 'string' || !Object.hasOwn(listProviderDefinitions(), id) ||
            typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/.test(model)) {
          fail(400, 'Invalid provider/model selection.')
          return
        }
        const { profile, models } = await getModels(id)
        if (!models.includes(model)) { fail(400, 'Model is not available to the selected provider.'); return }
        // No real key or upstream metadata is sent to the coding engine.
        rememberModel(id, model)
        selectProvider(id)
        active = { id, endpoint: profile.endpoint, key: profile.key }
        credentialRevoked = false
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ provider: id, model }))
      } catch {
        fail(400, 'Provider switch rejected; previous provider retained.')
      }
      return
    }
    // Search is independent of the selected AI model. Only the parent holds
    // the search-provider credential, never the model, tools, or MCP process.
    if (req.url === '/v1/bccli/web-search') {
      if (req.method !== 'POST') { fail(405, 'Method not allowed.'); return }
      if (!searchApiKey?.trim()) { fail(404, 'Search service is not configured.'); return }
      if (searchesUsed >= 20) { fail(429, 'Session search limit reached.'); return }
      if (Number(req.headers['content-length'] || 0) > 1024) { fail(413, 'Search request too large.'); return }
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > 1024) { fail(413, 'Search request too large.'); return }
          chunks.push(chunk)
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'query')) {
          fail(400, 'Invalid search request.'); return
        }
        const query = validateSearchQuery(payload.query)
        searchesUsed += 1
        const answer = await searchImpl({ query, key: searchApiKey })
        res.writeHead(200, { 'content-type':'application/json', 'cache-control':'no-store' })
        res.end(JSON.stringify(answer))
      } catch {
        fail(502, 'Search backend unavailable or search query rejected.')
      }
      return
    }
    if (!ALLOWED_PATHS.has(req.url ?? '')) {
      fail(404, 'Unsupported local gateway route.')
      return
    }
    if (credentialRevoked || !active.key) {
      fail(409, 'The active API key was removed. Select or configure a provider with /provider before sending a new request.')
      return
    }
    const method = req.url === '/v1/models' ? 'GET' : 'POST'
    if (req.method !== method) {
      fail(405, 'Unsupported request method.')
      return
    }
    if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_REQUEST_BYTES) {
      fail(413, 'Request too large.')
      return
    }

    let counted = false
    const abort = new AbortController()
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', onClose)
    try {
      let body
      let parsedBody = null
      if (method === 'POST') {
        const buffers = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > MAX_REQUEST_BYTES) {
            fail(413, 'Request too large.')
            return
          }
          buffers.push(chunk)
        }
        body = Buffer.concat(buffers)
        if (req.url === '/v1/chat/completions') {
          let parsed
          try { parsed = JSON.parse(body.toString('utf8')) }
          catch { fail(400, 'Invalid JSON request.'); return }
          parsedBody = boundChatOutputTokens(attachRuntimeModelContext(normalizeZeroArgFunctionTools(parsed)), { endpoint: active.endpoint })
          if (parsedBody !== parsed) body = Buffer.from(JSON.stringify(parsedBody))
        }
      }
      inFlight += 1
      counted = true
      const destination = active
      const upstreamUrl = destination.endpoint + req.url.slice(3)
      const upstreamInit = {
        method,
        headers: {
          authorization: 'Bearer ' + destination.key,
          accept: 'application/json, text/event-stream',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body,
        redirect: 'error',
        signal: abort.signal,
      }
      // Some current OpenAI models answer only on the Responses route: the pro
      // and codex models refuse chat/completions outright, and two reasoning
      // models refuse both the tools+effort combination and the 'none' retry.
      // The bridge is reactive (the upstream refusal text is the trigger, never
      // a model list) and scoped to OpenAI's own endpoint, so every other
      // upstream keeps exactly the behavior it has today.
      const openAiChat = req.url === '/v1/chat/completions' && destination.endpoint === PROVIDERS.openai.endpoint && parsedBody !== null
      const sendResponsesRoute = () => fetchImpl(destination.endpoint + '/responses', {
        ...upstreamInit,
        body: Buffer.from(JSON.stringify(toResponsesRequest(parsedBody))),
      })
      let upstream
      let bufferedError = null
      let bufferedStatus = null
      let viaResponses = false
      if (openAiChat && responsesOnlyModels.has(parsedBody.model)) {
        upstream = await sendResponsesRoute()
        if (upstream.ok) viaResponses = true
        else {
          bufferedStatus = upstream.status
          bufferedError = await upstream.text()
        }
      } else {
        upstream = await fetchImpl(upstreamUrl, upstreamInit)
      }
      if (bufferedError === null && !viaResponses && openAiChat && (upstream.status === 400 || upstream.status === 404)) {
        const rejected = await upstream.text()
        let bridge = null
        if (RESPONSES_ONLY_REJECTION.test(rejected)) {
          bridge = await sendResponsesRoute()
        } else if (upstream.status === 400) {
          const retryBody = reasoningDisabledRetryBody(body, rejected)
          const retry = retryBody ? await fetchImpl(upstreamUrl, { ...upstreamInit, body: retryBody }) : null
          if (retry && retry.status !== 400) upstream = retry
          else if (retry) {
            const retryRejected = await retry.text()
            if (REASONING_NONE_UNSUPPORTED.test(retryRejected)) bridge = await sendResponsesRoute()
            else bufferedError = rejected
          } else bufferedError = rejected
        } else bufferedError = rejected
        if (bridge) {
          if (bridge.ok) {
            upstream = bridge
            viaResponses = true
            responsesOnlyModels.add(parsedBody.model)
          } else {
            bufferedStatus = bridge.status
            bufferedError = await bridge.text()
          }
        }
      }
      if (bufferedError !== null) {
        res.writeHead(bufferedStatus ?? upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        if (!res.destroyed) res.write(bufferedError)
      } else if (viaResponses) {
        if (parsedBody.stream) {
          res.writeHead(upstream.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          const translator = createResponsesChatTranslator({ includeUsage: parsedBody.stream_options?.include_usage === true })
          const decoder = new TextDecoder()
          for await (const piece of upstream.body) {
            if (res.destroyed) break
            const translated = translator.push(decoder.decode(piece, { stream: true }))
            if (translated && !res.write(translated)) await waitForDrainOrClose(res)
          }
          const tail = translator.push(decoder.decode()) + translator.finish()
          if (tail && !res.destroyed) res.write(tail)
        } else {
          const translated = responsesJsonToChat(await upstream.json())
          res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          if (!res.destroyed) res.write(JSON.stringify(translated))
        }
      } else {
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-store',
        })
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            if (res.destroyed) break
            if (!res.write(chunk)) await waitForDrainOrClose(res)
          }
        }
      }
      res.end()
    } catch {
      if (res.headersSent) res.destroy()
      else fail(502, 'Provider connection failed.')
    } finally {
      if (counted) inFlight -= 1
      res.off('close', onClose)
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const port = server.address()?.port
  return {
    token,
    baseUrl: 'http://127.0.0.1:' + port + '/v1',
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
