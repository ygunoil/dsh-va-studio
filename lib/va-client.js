import { createHash } from 'node:crypto'
import { VaStudioError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 120_000
const TOKEN_SKEW_MS = 60_000
const TOKEN_TTL_MS = 6 * 24 * 3600 * 1000

/** Normalize the configured origin: no trailing slash, no query, no hash. */
export function baseUrl(value) {
  const url = new URL(String(value))
  url.pathname = url.pathname.replace(/\/+$/u, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/u, '')
}

function apiUrl(base, path) {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

function detailText(detail) {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map(item => {
        if (!item || typeof item !== 'object') return String(item)
        const loc = Array.isArray(item.loc) ? item.loc.filter(part => part !== 'body').join('.') : ''
        return `${loc ? `${loc}: ` : ''}${item.msg || item.error || JSON.stringify(item)}`
      })
      .join('; ')
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail)
  return ''
}

async function readError(response) {
  let body = ''
  try {
    body = (await response.text()).slice(0, 4_096)
  } catch {
    // ignore
  }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const detail = body && parsed === undefined ? body : detailText(parsed?.detail ?? parsed?.error ?? parsed?.message ?? body)
  return {
    detail: String(detail || response.statusText || 'request failed').slice(0, 500),
    code: parsed?.code || '',
    requiredPoints: parsed?.requiredPoints,
    availablePoints: parsed?.availablePoints,
  }
}

function errorForStatus(status, info) {
  const detail = info.detail
  if (status === 402 || info.code === 'INSUFFICIENT_POINTS') {
    const extra = Number.isFinite(info.requiredPoints) || Number.isFinite(info.availablePoints)
      ? `（需要 ${info.requiredPoints ?? '?'} 积分，可用 ${info.availablePoints ?? '?'}）`
      : ''
    return new VaStudioError('INSUFFICIENT_POINTS', `VA Studio 积分不足${extra}：${detail}`, status, {
      httpStatus: status,
      requiredPoints: info.requiredPoints,
      availablePoints: info.availablePoints,
    })
  }
  if (status === 401) return new VaStudioError('AUTH', `VA Studio 登录失效：${detail}`, status, { httpStatus: status })
  if (status === 403) return new VaStudioError('PERMISSION', `VA Studio 拒绝访问：${detail}`, status, { httpStatus: status })
  if (status === 404) return new VaStudioError('HTTP', `VA Studio 返回 404：${detail}`, status, { httpStatus: status })
  if (status === 409) return new VaStudioError('CONFLICT', `VA Studio 资源冲突：${detail}`, status, { httpStatus: status })
  if (status === 422) return new VaStudioError('VALIDATION', `VA Studio 参数校验失败：${detail}`, status, { httpStatus: status })
  if (status === 429) return new VaStudioError('RATE_LIMITED', `VA Studio 请求过于频繁：${detail}`, status, { httpStatus: status })
  return new VaStudioError('HTTP', `VA Studio 返回 ${status}：${detail}`, status, { httpStatus: status })
}

async function fetchJson(url, init, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  let response
  try {
    response = await fetch(url, { ...init, signal, redirect: 'follow' })
  } catch (error) {
    if (signal.aborted) {
      if (init?.signal?.aborted) throw new VaStudioError('ABORTED', '操作已取消。', 499)
      throw new VaStudioError('TIMEOUT', '连接 VA Studio 超时，请检查后端是否在运行。', 504)
    }
    throw new VaStudioError('UNAVAILABLE', `无法连接 VA Studio（${url}）：${error?.message || error}`, 503)
  }
  if (!response.ok) {
    throw errorForStatus(response.status, await readError(response))
  }
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function health(base, signal) {
  const data = await fetchJson(apiUrl(baseUrl(base), '/api/drama/health'), { signal }, 20_000)
  return data
}

export async function login({ baseUrl: base, username, password, signal }) {
  const data = await fetchJson(
    apiUrl(baseUrl(base), '/api/auth/login'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal,
    },
    30_000,
  )
  if (!data || typeof data.token !== 'string' || !data.token) {
    throw new VaStudioError('AUTH', 'VA Studio 登录响应缺少 token。', 502)
  }
  return data
}

export async function me({ baseUrl: base, token, signal }) {
  return fetchJson(
    apiUrl(baseUrl(base), '/api/auth/me'),
    { headers: { Authorization: `Bearer ${token}` }, signal },
    30_000,
  )
}

function connectionFingerprint(conn) {
  const secret = conn.mode === 'token' ? conn.token : `${conn.username}:${conn.password}`
  return createHash('sha256').update(`${conn.baseUrl}\u0000${conn.mode}\u0000${secret}`).digest('hex')
}

/** In-memory token cache; the credential record remains the only persisted secret. */
const tokenCache = new Map()

export function clearTokenCache() {
  tokenCache.clear()
}

export class VaClient {
  constructor(conn, { signal } = {}) {
    this.connection = conn
    this.baseUrl = baseUrl(conn.baseUrl)
    this.signal = signal
    this.fingerprint = connectionFingerprint(conn)
  }

  get token() {
    const hit = tokenCache.get(this.fingerprint)
    if (!hit || hit.expiresAt <= Date.now() + TOKEN_SKEW_MS) return undefined
    return hit.token
  }

  async authenticate(force = false, signal = this.signal) {
    if (!force) {
      const cached = this.token
      if (cached) return cached
    }
    const conn = this.connection
    let result
    if (conn.mode === 'token') {
      await me({ baseUrl: this.baseUrl, token: conn.token, signal })
      result = { token: conn.token }
    } else {
      result = await login({ baseUrl: this.baseUrl, username: conn.username, password: conn.password, signal })
    }
    tokenCache.set(this.fingerprint, { token: result.token, expiresAt: Date.now() + TOKEN_TTL_MS })
    return result.token
  }

  async request(path, { method = 'GET', body, form, signal, timeoutMs, auth = true, retry = true } = {}) {
    const merged = signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal
    const headers = {}
    let payload
    if (auth) {
      headers.Authorization = `Bearer ${await this.authenticate(false, merged)}`
    }
    if (form) {
      payload = form
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    try {
      return await fetchJson(apiUrl(this.baseUrl, path), { method, headers, body: payload, signal: merged }, timeoutMs)
    } catch (error) {
      if (retry && auth && error instanceof VaStudioError && error.code === 'AUTH') {
        tokenCache.delete(this.fingerprint)
        headers.Authorization = `Bearer ${await this.authenticate(true, merged)}`
        return fetchJson(apiUrl(this.baseUrl, path), { method, headers, body: payload, signal: merged }, timeoutMs)
      }
      throw error
    }
  }

  /** Streamed SSE request. Yields `{ event, data }`; `data` is parsed JSON when
   * possible, otherwise the raw string. Long streams rely on the caller's
   * signal and the per-request timeout supplied by the caller. */
  async *stream(path, { method = 'POST', body, signal, timeoutMs = 900_000, auth = true } = {}) {
    const merged = signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal || this.signal
    const headers = { Accept: 'text/event-stream' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) headers.Authorization = `Bearer ${await this.authenticate(false, merged)}`
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = merged ? AbortSignal.any([merged, timeout]) : timeout
    let response
    try {
      response = await fetch(apiUrl(this.baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      throw new VaStudioError('UNAVAILABLE', `VA Studio 流式接口连接失败：${error?.message || error}`, 503)
    }
    if (!response.ok) throw errorForStatus(response.status, await readError(response))
    if (!response.body) throw new VaStudioError('PROTOCOL', 'VA Studio 流式响应为空。', 502)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseSseBlock(raw)
          if (event) yield event
        }
      }
      buffer += decoder.decode()
      const tail = parseSseBlock(buffer)
      if (tail) yield tail
    } finally {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
    }
  }
}

export function parseSseBlock(block) {
  const lines = String(block).split(/\r?\n/)
  let event = 'message'
  const dataLines = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''))
  }
  if (!dataLines.length) return undefined
  const text = dataLines.join('\n')
  let data = text
  try {
    data = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return { event, data }
}

/** Build a client from a resolved connection record. */
export function clientFor(conn, options) {
  return new VaClient(conn, options)
}

/** Parse a JSON text field the model supplied; accepts an object or a JSON string. */
export function parseJsonField(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new VaStudioError('INVALID_ARGUMENT', `${label} 必须是合法 JSON。`, 400)
  }
}
