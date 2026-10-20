import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSseBlock, VaClient, baseUrl } from '../lib/va-client.js'
import { startMockVa } from './mock-va-server.mjs'

let server

before(async () => {
  server = await startMockVa()
})

after(async () => {
  await server?.close()
})

test('normalizes backend URLs', () => {
  assert.equal(baseUrl('http://127.0.0.1:8790/'), 'http://127.0.0.1:8790')
  assert.equal(baseUrl('http://127.0.0.1:8790/api/'), 'http://127.0.0.1:8790/api')
  assert.throws(() => baseUrl('not a url'))
})

test('parses SSE blocks including comments and multiline data', () => {
  assert.deepEqual(parseSseBlock('event: status\ndata: {"message":"ok"}'), { event: 'status', data: { message: 'ok' } })
  assert.deepEqual(parseSseBlock(': heartbeat'), undefined)
  assert.deepEqual(parseSseBlock('event: progress\ndata: first\ndata: second'), { event: 'progress', data: 'first\nsecond' })
})

test('logs in, caches the token and performs authenticated requests', async () => {
  const client = new VaClient({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'pw' })
  const me = await client.request('/api/auth/me')
  assert.equal(me.username, 'tester')
  const repeat = await client.request('/api/auth/me')
  assert.equal(repeat.username, 'tester')
  // One login is enough for both requests (token cache).
  assert.equal(server.requests.filter(r => r.path === '/api/auth/login').length, 1)
})

test('maps 402 insufficient points with the amounts', async () => {
  const client = new VaClient({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'pw' })
  await assert.rejects(client.request('/api/novel/stream', { method: 'POST', body: { idea: '积分不足' } }), error => {
    assert.equal(error.code, 'INSUFFICIENT_POINTS')
    assert.equal(error.requiredPoints, 100)
    assert.equal(error.availablePoints, 3)
    assert.match(error.message, /100/)
    return true
  })
})

test('maps validation and permission failures', async () => {
  const client = new VaClient({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'pw' })
  await assert.rejects(
    client.request('/api/screenplay/stream', { method: 'POST', body: { sourceType: 'novel' } }),
    error => error.code === 'VALIDATION' && /novelId/.test(error.message),
  )
  await assert.rejects(
    client.request('/api/screenplay/records/sp-1', { signal: AbortSignal.abort() }),
    error => error.code === 'ABORTED' || error.code === 'UNAVAILABLE',
  )
})

test('rejects an invalid password without caching a token', async () => {
  const client = new VaClient({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'wrong' })
  await assert.rejects(client.request('/api/auth/me'), error => error.code === 'AUTH')
})
