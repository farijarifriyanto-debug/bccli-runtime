import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { startGatewayProxy } from '../proxy.mjs'
import { BCCLI_PROVIDER_COMMAND } from '../provider-command.mjs'

function localFixture({ promptValue = 'VALID_EXAMPLE_SECRET', approved = true, acceptNew = true } = {}) {
  const keys = new Map([['botconnector', 'OLD_BC_SECRET']])
  const calls = []
  const changes = []
  const opts = {
    liveProvider: true, initialProvider: 'botconnector', endpoint: 'https://api.botconnector.id/v1',
    key: keys.get('botconnector'), token: 'LOCAL_SESSION_TOKEN',
    configured: id => keys.has(id),
    resolveProfile: id => ({ id, key: keys.get(id), endpoint: {
      botconnector: 'https://api.botconnector.id/v1',
      openai: 'https://api.openai.com/v1',
    }[id] }),
    secureKeyPrompt: async id => { calls.push(['prompt',id]);return promptValue },
    secureRemoveConfirm: async id => { calls.push(['confirm',id]);return approved },
    persistKey: (id,key) => { keys.set(id,key);calls.push(['save',id]) },
    deleteKey: id => { keys.delete(id);calls.push(['delete',id]) },
    selectProvider: id => changes.push(['provider',id]),
    rememberModel: (id,model) => changes.push(['model',id,model]),
    // These fixtures resolve native dialogs instantly, which no human can do;
    // the production cooldown would otherwise rate-limit legitimate quick
    // add/select/remove sequences. The gates themselves are covered by the
    // dedicated rate-limit tests in proxy.test.mjs.
    dialogLimits: { cooldownMs: 0, perSession: 10 },
    switchLimits: { cooldownMs: 0, perSession: 20 },
    fetchImpl: async (url,req) => {
      calls.push(['fetch',url,req.headers?.authorization])
      if (url.endsWith('/models')) {
        if (url.includes('api.openai.com') && (req.headers.authorization !== 'Bearer VALID_EXAMPLE_SECRET' || !acceptNew)) {
          return Response.json({ error: 'invalid key' }, { status: 401 })
        }
        return Response.json({ data: [{ id: url.includes('api.openai.com') ? 'gpt-4.1' : 'ling-3.0-flash' }] })
      }
      return Response.json({ id: 'fake-call', choices: [] })
    },
  }
  return { keys,calls,changes,opts }
}

function command(proxy) {
  const state = { current: 'ling-3.0-flash' }
  const value = vm.runInNewContext(BCCLI_PROVIDER_COMMAND + '\nauthCommand', {
    process: { env: { OPENAI_BASE_URL:proxy.baseUrl,OPENAI_API_KEY:proxy.token } },
    fetch,AbortSignal,JSON,Object,String,Number,Error,RegExp,__name:f=>f,
  })
  const config = {
    getModel: () => state.current,
    async setModel(x) { state.current=x },
  }
  return { state, call: args => value.action({ invocation:{args},services:{config} },args) }
}

test('menu offers secure key add/delete and masks all stored key values', async () => {
  const fixture=localFixture()
  const proxy=await startGatewayProxy(fixture.opts)
  try {
    const ui=command(proxy)
    const menu=await ui.call('list')
    assert.match(menu.content,/Save\/replace key: \/provider add NAME/)
    assert.match(menu.content,/Delete saved key: \/provider remove NAME/)
    const saved=await ui.call('add openai')
    assert.equal(saved.messageType,'info')
    assert.match(saved.content,/Windows DPAPI/)
    assert.equal(fixture.keys.get('openai'),'VALID_EXAMPLE_SECRET')
    assert.deepEqual(fixture.calls.filter(x=>x[0]==='prompt'),[['prompt','openai']])
    assert.doesNotMatch(JSON.stringify(menu)+JSON.stringify(saved), /VALID_EXAMPLE_SECRET|OLD_BC_SECRET|LOCAL_SESSION_TOKEN/)
    const catalog=await ui.call('openai')
    assert.equal(catalog.type,'dialog')
    const selected=await ui.call('openai gpt-4.1')
    assert.equal(selected.messageType,'info')
    assert.equal(ui.state.current,'gpt-4.1')
    const removed=await ui.call('remove openai')
    assert.match(removed.content,/now blocked/)
    assert.equal(fixture.keys.has('openai'),false)
    assert.deepEqual(fixture.calls.filter(x=>x[0]==='confirm'),[['confirm','openai']])
    const chat=await fetch(proxy.baseUrl+'/chat/completions',{
      method:'POST',headers:{ authorization:'Bearer '+proxy.token,'content-type':'application/json' },
      body:JSON.stringify({model:'gpt-4.1',messages:[{role:'user',content:'should not be sent'}]})
    })
    assert.equal(chat.status,409,'deleted active key must not send a charged model request')
    assert.equal(fixture.calls.filter(x=>x[0]==='fetch'&&x[1].includes('chat/completions')).length,0)
  } finally {await proxy.close()}
})

test('cancellation and invalid key leave earlier credential unchanged',async () => {
  const fixture=localFixture({ promptValue:null,approved:false })
  fixture.keys.set('openai','EXISTING_SAVED_SECRET')
  const proxy=await startGatewayProxy(fixture.opts)
  try {
    const ui=command(proxy)
    assert.match((await ui.call('replace openai')).content,/Cancelled/)
    assert.equal(fixture.keys.get('openai'),'EXISTING_SAVED_SECRET')
    assert.match((await ui.call('delete openai')).content,/Cancelled/)
    assert.equal(fixture.keys.get('openai'),'EXISTING_SAVED_SECRET')
    assert.equal(fixture.calls.filter(x=>x[0]==='save'||x[0]==='delete').length,0)
    assert.equal((await ui.call('add invalid-provider')).messageType,'error')
  } finally {await proxy.close()}
  const invalid=localFixture({ promptValue:'WRONG_SECRET',acceptNew:false })
  invalid.keys.set('openai','EXISTING_SAVED_SECRET')
  const local=await startGatewayProxy(invalid.opts)
  try {
    const ui=command(local)
    const result=await ui.call('add openai')
    assert.equal(result.messageType,'error')
    assert.equal(invalid.keys.get('openai'),'EXISTING_SAVED_SECRET')
    assert.equal(invalid.calls.filter(x=>x[0]==='save').length,0)
    assert.doesNotMatch(JSON.stringify(result),/WRONG_SECRET/)
  } finally {await local.close()}
})

test('key management is authenticated, provider-only, and never accepts a key from chat',async () => {
  const f=localFixture()
  const proxy=await startGatewayProxy(f.opts)
  try {
    const endpoint=proxy.baseUrl+'/bccli/provider/key/add'
    const noAuth=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({ action:'user-confirmed-local-key-dialog',provider:'openai' })})
    assert.equal(noAuth.status,401)
    const extraKey=await fetch(endpoint,{method:'POST',headers:{
      authorization:'Bearer '+proxy.token,'content-type':'application/json'
    },body:JSON.stringify({ action:'user-confirmed-local-key-dialog',provider:'openai', key:'MUST_NEVER_ACCEPT_CHAT_KEY' })})
    assert.equal(extraKey.status,400)
    assert.equal(f.calls.filter(x=>x[0]==='prompt').length,0)
    assert.equal(f.keys.has('openai'),false)
  } finally {await proxy.close()}
})
