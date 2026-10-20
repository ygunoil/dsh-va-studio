import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettings, CONNECTION_KEY } from '../lib/settings.js'

function harness() {
  let record
  const credentials = {
    async readRecord() {
      return record
    },
    async describeRecord() {
      return { configured: Boolean(record), writable: true }
    },
    async modifyRecord(key, mutate) {
      assert.equal(key, CONNECTION_KEY)
      record = await mutate(record)
    },
  }
  const ctx = { credentials, logger: { info() {} } }
  return { ctx, settings: createSettings(ctx, { validate: false }), peek: () => record }
}

const BASE = 'http://127.0.0.1:8790'

test('starts unconfigured with a loopback default', async () => {
  const { settings } = harness()
  const described = await settings.describe()
  assert.equal(described.configured, false)
  assert.equal(described.baseUrl, BASE)
  assert.equal(described.revision, 0)
  await assert.rejects(settings.active(), error => error.code === 'NOT_CONFIGURED')
})

test('saves password auth, then reuses the secret on a blank update', async () => {
  const { settings, peek } = harness()
  await settings.save({ baseUrl: `${BASE}/`, mode: 'password', username: 'tester', password: 'pw' })
  const first = await settings.describe()
  assert.equal(first.configured, true)
  assert.equal(first.baseUrl, BASE)
  assert.equal(first.revision, 1)
  assert.equal(first.hasPassword, true)
  assert.equal(peek().payload.password, 'pw')

  const second = await settings.save({ revision: 1, baseUrl: BASE, mode: 'password', username: 'tester' })
  assert.equal(second.revision, 2)
  assert.equal(peek().payload.password, 'pw')

  await assert.rejects(
    settings.save({ revision: 2, baseUrl: 'http://127.0.0.1:9999', mode: 'password', username: 'tester' }),
    error => error.code === 'CREDENTIAL',
  )
})

test('rejects a stale revision with CONFLICT', async () => {
  const { settings } = harness()
  await settings.save({ baseUrl: BASE, mode: 'password', username: 'tester', password: 'pw' })
  await assert.rejects(
    settings.save({ revision: 0, baseUrl: BASE, mode: 'password', username: 'tester', password: 'pw2' }),
    error => error.code === 'CONFLICT',
  )
})

test('supports token auth and rejects malformed endpoints', async () => {
  const { settings } = harness()
  await assert.rejects(settings.save({ baseUrl: 'ftp://x', mode: 'token', token: 't' }), /http 或 https/)
  await assert.rejects(settings.save({ baseUrl: BASE, mode: 'token', token: '' }), /访问令牌/)
  const saved = await settings.save({ baseUrl: BASE, mode: 'token', token: 'abc.def' })
  assert.equal(saved.authMode, 'token')
  assert.equal(saved.hasToken, true)
  assert.equal(saved.hasPassword, false)
  const active = await settings.active()
  assert.equal(active.token, 'abc.def')
})

test('does not persist when credential storage is read-only', async () => {
  let record
  const ctx = {
    credentials: {
      async readRecord() {
        return record
      },
      async describeRecord() {
        return { configured: false, writable: false }
      },
      async modifyRecord() {
        throw new Error('should not write')
      },
    },
    logger: { info() {} },
  }
  const settings = createSettings(ctx, { validate: false })
  await assert.rejects(
    settings.save({ baseUrl: BASE, mode: 'password', username: 'tester', password: 'pw' }),
    error => error.code === 'READ_ONLY',
  )
})

test('validating save verifies health and sign-in against a live backend', async () => {
  const { startMockVa } = await import('./mock-va-server.mjs')
  const server = await startMockVa()
  try {
    let record
    const ctx = {
      credentials: {
        async readRecord() {
          return record
        },
        async describeRecord() {
          return { configured: Boolean(record), writable: true }
        },
        async modifyRecord(key, mutate) {
          record = await mutate(record)
        },
      },
      logger: { info() {} },
    }
    const settings = createSettings(ctx)
    const saved = await settings.save({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'pw' })
    assert.equal(saved.configured, true)
    assert.equal(saved.revision, 1)

    await assert.rejects(
      settings.save({ revision: 1, baseUrl: server.url, mode: 'password', username: 'tester', password: 'wrong' }),
      error => error.code === 'AUTH',
    )
    await assert.rejects(
      settings.test({ baseUrl: 'http://127.0.0.1:1', mode: 'password', username: 'tester', password: 'pw' }),
      error => error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT',
    )
  } finally {
    await server.close()
  }
})
