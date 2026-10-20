/** Error type shared by the VA Studio plugin. Every failure the model sees keeps a
 * stable code so the skill prompt can tell the user what to fix instead of
 * guessing. Host-side details never include credentials. */
export class VaStudioError extends Error {
  constructor(code, message, status = 500, extra = {}) {
    super(message)
    this.name = 'VaStudioError'
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

export function safeError(error) {
  if (error instanceof VaStudioError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new VaStudioError('UNAVAILABLE', message || 'VA Studio request failed.', 503)
}

export function jsonResponse(run) {
  return (async () => {
    try {
      return Response.json(await run(), { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const safe = safeError(error)
      return Response.json(
        { code: safe.code, error: safe.message },
        { status: safe.status, headers: { 'Cache-Control': 'no-store' } },
      )
    }
  })()
}

export async function readJsonBody(request, limit = 16_384) {
  const text = await request.text()
  if (text.length > limit) throw new VaStudioError('REQUEST_TOO_LARGE', 'Request body is too large.', 413)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new VaStudioError('INVALID_REQUEST', 'Request body must be valid JSON.', 400)
  }
}
