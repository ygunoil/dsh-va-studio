import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { VaStudioError } from './errors.js'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
}

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 120 * 1024 * 1024

function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

/** Resolve the session workspace root a tool is allowed to read local media from. */
export function workspaceRoot(exec) {
  const root = exec?.agent?.session?.header?.cwd
  if (!root) {
    throw new VaStudioError(
      'WORKSPACE',
      '当前会话没有工作区，无法读取本地图片/视频。请先把文件放入工作区，或者改用 http(s) 直链。',
      400,
    )
  }
  return root
}

/** Read a local media file for multipart upload. Only files inside the session
 * workspace are readable: the model cannot turn an upload tool into a way to
 * exfiltrate unrelated files from the host. */
export async function readWorkspaceMedia(exec, filePath, { kind = 'image', maxBytes } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new VaStudioError('INVALID_ARGUMENT', '请提供工作区内的文件路径。', 400)
  }
  const root = await realpath(workspaceRoot(exec))
  const absolute = path.resolve(root, filePath)
  let info
  try {
    info = await lstat(absolute)
  } catch {
    throw new VaStudioError('FILE_NOT_FOUND', `找不到文件：${filePath}`, 404)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new VaStudioError('FILE_NOT_FOUND', '只能上传普通文件，符号链接和其它类型会被拒绝。', 400)
  }
  const real = await realpath(absolute)
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new VaStudioError('FILE_OUTSIDE_WORKSPACE', '只能上传当前会话工作区内的文件。', 400)
  }
  const stats = await stat(real)
  const limit = maxBytes || (kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES)
  if (stats.size > limit) {
    throw new VaStudioError(
      'FILE_TOO_LARGE',
      `文件超过 ${Math.round(limit / 1024 / 1024)}MB 上限，请压缩或截短后再上传。`,
      400,
    )
  }
  if (stats.size === 0) throw new VaStudioError('FILE_EMPTY', '文件为空。', 400)
  const buffer = await readFile(real)
  return { buffer, name: path.basename(real), mime: mimeFor(real), size: buffer.length }
}

export async function mediaForm(file, fields = {}) {
  const form = new FormData()
  form.append('file', new Blob([file.buffer], { type: file.mime }), file.name)
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value))
  }
  return form
}
