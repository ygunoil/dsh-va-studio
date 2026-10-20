import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { VaStudioError, safeError } from './errors.js'
import { baseUrl as normalizeBaseUrl, health, login, me } from './va-client.js'

/** Single credential record holds the connection as one atomic value, so a
 * failed save can never pair a new base URL with an old credential. */
export const CONNECTION_KEY = credentialKey('dsh-va-studio', 'connection')

const MAX_BASE_URL = 2_048
const MAX_SECRET = 4_096

const EMPTY = () => ({ revision: 0, baseUrl: 'http://127.0.0.1:8790', mode: 'password', username: '' })

function cleanBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > MAX_BASE_URL) {
    throw new VaStudioError('ENDPOINT', '请填写 VA Studio 后端地址，例如 http://127.0.0.1:8790', 400)
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new VaStudioError('ENDPOINT', 'VA Studio 后端地址不是合法 URL。', 400)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new VaStudioError('ENDPOINT', 'VA Studio 后端地址必须是 http 或 https。', 400)
  }
  if (url.username || url.password) {
    throw new VaStudioError('ENDPOINT', 'VA Studio 后端地址里不要包含账号密码。', 400)
  }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  url.search = ''
  url.hash = ''
  return normalizeBaseUrl(url.toString())
}

function cleanSecret(value, label) {
  const text = String(value ?? '')
  if (!text.trim()) throw new VaStudioError('CREDENTIAL', `请填写${label}。`, 400)
  if (text.length > MAX_SECRET || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new VaStudioError('CREDENTIAL', `${label}格式不正确。`, 400)
  }
  return text.trim()
}

function cleanUsername(value) {
  return String(value ?? '').trim().slice(0, 160)
}

export function describeConnection(state, writable) {
  return {
    configured: Boolean(state.baseUrl && (state.mode === 'token' ? state.token : state.username && state.password)),
    revision: state.revision,
    writable,
    baseUrl: state.baseUrl,
    mode: state.mode,
    username: state.username || '',
    authMode: state.mode,
    hasToken: Boolean(state.token),
    hasPassword: Boolean(state.password),
  }
}

export function createSettings(ctx, { validate = true } = {}) {
  async function read() {
    let record
    try {
      record = await ctx.credentials.readRecord(CONNECTION_KEY)
    } catch (error) {
      if (error instanceof VaStudioError) throw error
      throw new VaStudioError('LOAD_FAILED', '无法读取已保存的 VA Studio 连接配置。', 503)
    }
    if (!record) return EMPTY()
    if (record.kind !== 'grant' || !record.payload || !Number.isSafeInteger(record.payload.revision)) {
      throw new VaStudioError('CONFIGURATION', '已保存的 VA Studio 连接配置需要重新保存。', 500)
    }
    return { ...EMPTY(), ...record.payload }
  }

  async function writable() {
    try {
      return (await ctx.credentials.describeRecord(CONNECTION_KEY)).writable
    } catch {
      return true
    }
  }

  async function describe() {
    try {
      return describeConnection(await read(), await writable())
    } catch (error) {
      const safe = safeError(error)
      ctx.logger.info('va-studio: settings describe failed; code=%s', safe.code)
      throw safe
    }
  }

  async function isConfigured() {
    const state = await read()
    return Boolean(state.baseUrl && (state.mode === 'token' ? state.token : state.username && state.password))
  }

  function prepare(input, before = EMPTY()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new VaStudioError('INVALID_REQUEST', '请填写 VA Studio 连接配置。', 400)
    }
    const next = {
      baseUrl: cleanBaseUrl(input.baseUrl),
      mode: input.mode === 'token' ? 'token' : 'password',
      username: cleanUsername(input.username),
    }
    // A blank secret keeps the saved one when the identity did not change; the
    // client never receives the stored value back.
    const unchanged = next.baseUrl === before.baseUrl && next.username === (before.username || '')
    if (next.mode === 'password') {
      if (!next.username) throw new VaStudioError('CREDENTIAL', '请填写 VA Studio 账号。', 400)
      const typed = String(input.password ?? '')
      if (typed.trim()) next.password = cleanSecret(typed, '密码')
      else if (before.mode === 'password' && before.password && unchanged) next.password = before.password
      else throw new VaStudioError('CREDENTIAL', '请填写 VA Studio 密码。', 400)
    } else {
      const typed = String(input.token ?? '')
      if (typed.trim()) next.token = cleanSecret(typed, '访问令牌')
      else if (before.mode === 'token' && before.token && next.baseUrl === before.baseUrl) next.token = before.token
      else throw new VaStudioError('CREDENTIAL', '请填写访问令牌。', 400)
    }
    return next
  }

  async function verify(next, signal) {
    await health(next.baseUrl, signal)
    if (next.mode === 'token') {
      await me({ baseUrl: next.baseUrl, token: next.token, signal })
    } else {
      await login({ baseUrl: next.baseUrl, username: next.username, password: next.password, signal })
    }
  }

  async function save(input, signal) {
    if (!(await writable())) throw new VaStudioError('READ_ONLY', '当前凭据存储为只读，无法保存配置。', 403)
    const before = await read()
    if (input?.revision !== undefined && input.revision !== before.revision) {
      throw new VaStudioError('CONFLICT', '配置已在其他窗口更新，请重新打开设置后保存。', 409)
    }
    const next = prepare(input, before)
    if (validate) {
      try {
        await verify(next, signal)
      } catch (error) {
        const safe = safeError(error)
        ctx.logger.info('va-studio: connection validation failed; code=%s', safe.code)
        throw safe
      }
      signal?.throwIfAborted()
    }
    const revision = before.revision + 1
    await ctx.credentials.modifyRecord(CONNECTION_KEY, async () => ({
      kind: 'grant',
      payload: { revision, ...next },
    }))
    ctx.logger.info('va-studio: connection saved; baseUrl=%s mode=%s', next.baseUrl, next.mode)
    return describeConnection({ revision, ...next }, true)
  }

  async function test(input, signal) {
    const candidate = input && input.baseUrl ? prepare(input, await read()) : await read()
    await verify(candidate, signal)
    return {
      ok: true,
      baseUrl: candidate.baseUrl,
      mode: candidate.mode,
      username: candidate.username || '',
    }
  }

  /** Resolve the connection for a tool call. Throws a model-readable error when
   * the plugin has not been configured yet. */
  async function active() {
    const state = await read()
    if (!state.baseUrl || !(state.mode === 'token' ? state.token : state.username && state.password)) {
      throw new VaStudioError(
        'NOT_CONFIGURED',
        '尚未配置 VA Studio 连接。请打开「设置 → 插件 → VA Studio」填写后端地址和账号后保存。',
        400,
      )
    }
    return state
  }

  return { read, describe, isConfigured, save, test, active }
}
