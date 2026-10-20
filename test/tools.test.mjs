import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerTools } from '../lib/tools.js'
import { startMockVa } from './mock-va-server.mjs'

let server
let workspace
let tools
const ctx = {
  tools: { register: definition => tools.set(definition.name, definition) },
  logger: { info() {} },
}
const settings = {
  active: async () => ({ baseUrl: server.url, mode: 'password', username: 'tester', password: 'pw' }),
  isConfigured: async () => true,
}

function exec() {
  return { signal: AbortSignal.timeout(20_000), agent: { session: { header: { cwd: workspace } } } }
}

before(async () => {
  server = await startMockVa()
  workspace = await mkdtemp(path.join(os.tmpdir(), 'va-studio-test-'))
  await mkdir(path.join(workspace, 'refs'), { recursive: true })
  await writeFile(path.join(workspace, 'refs', 'cat.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  tools = new Map()
  registerTools(ctx, settings)
})

after(async () => {
  await server?.close()
  await rm(workspace, { recursive: true, force: true })
})

test('registers every tool with callable definitions', () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'va_studio_expand_prompt',
      'va_studio_generate_drama',
      'va_studio_generate_image',
      'va_studio_generate_novel',
      'va_studio_generate_screenplay',
      'va_studio_generate_video',
      'va_studio_job',
      'va_studio_produce_video',
      'va_studio_reverse_prompt',
      'va_studio_status',
    ].sort(),
  )
  for (const definition of tools.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.description, 'string')
  }
})

test('status reports health, user and configured models', async () => {
  const value = await tools.get('va_studio_status').execute({}, exec())
  assert.equal(value.ok, true)
  assert.equal(value.username, 'tester')
  assert.equal(value.health.status, 'ok')
  assert.match(value.aiSummary, /llm_doubao/)
})

test('expand_prompt returns the expanded prompt', async () => {
  const value = await tools.get('va_studio_expand_prompt').execute({ text: '雨夜天台', target: 'image' }, exec())
  assert.match(value.prompt, /扩写后的提示词：雨夜天台/)
  const body = server.requests.filter(r => r.path === '/api/prompt/expand').at(-1)
  assert.match(body.body, /"text":"雨夜天台"/)
})

test('generate_novel creates a record, polls the job and returns markdown', async () => {
  const value = await tools.get('va_studio_generate_novel').execute(
    { idea: '外卖员捡到死亡倒计时手表', chapters: 1, words_per_chapter: 1000, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.status, 'done')
  assert.equal(value.novelId, 'novel-1')
  assert.match(value.markdown, /倒计时手表/)
  const created = server.requests.find(r => r.path === '/api/novel/records' && r.method === 'POST')
  assert.match(created.body, /"status":"generating"/)
  const submitted = server.requests.find(r => r.path === '/api/novel/stream')
  assert.match(submitted.body, /"novelRecordId":"novel-1"/)
  assert.match(submitted.body, /"workMode":"short"/)
})

test('generate_novel surfaces insufficient points', async () => {
  await assert.rejects(
    tools.get('va_studio_generate_novel').execute({ idea: '充值积分不足测试', wait_seconds: 1 }, exec()),
    error => {
      assert.match(error.message, /INSUFFICIENT_POINTS/)
      assert.match(error.message, /需要 100 积分/)
      return true
    },
  )
})

test('generate_screenplay returns market text and episode count', async () => {
  const value = await tools.get('va_studio_generate_screenplay').execute(
    { idea: '社畜被拉进死亡电梯', episode_count: 2, duration_seconds: 60, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.screenplayId, 'sp-1')
  assert.match(value.marketText, /第一集/)
  assert.equal(value.episodeCount, 2)
})

test('generate_drama returns a compact shot list', async () => {
  const value = await tools.get('va_studio_generate_drama').execute(
    { idea: '外卖员捡到死亡倒计时手表', target_duration_sec: 60, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.projectId, 'proj-1')
  assert.equal(value.shotCount, 2)
  assert.equal(value.totalDurationSec, 10)
  assert.deepEqual(value.characters, ['男主', '女主'])
  assert.equal(value.shots[0].speaker, '男主')
})

test('generate_image creates a text-to-image job and returns absolute urls', async () => {
  const value = await tools.get('va_studio_generate_image').execute(
    { prompt: '雨夜霓虹灯下的黑猫', aspect_ratio: '9:16', resolution: '2K', count: 1, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.status, 'done')
  assert.equal(value.mode, 't2i')
  assert.equal(value.images.length, 1)
  assert.match(value.images[0].url, /^http:\/\/127\.0\.0\.1:\d+\/api\/image\/files\//)
  assert.equal(value.images[0].width, 1024)
  const submitted = server.requests.filter(r => r.path === '/api/image/generate/async').at(-1)
  assert.match(submitted.body, /"mode":"t2i"/)
  assert.match(submitted.body, /"aspectRatio":"9:16"/)
})

test('generate_image uploads workspace references for image-to-image', async () => {
  const value = await tools.get('va_studio_generate_image').execute(
    { prompt: '让这只猫眨眼', reference_paths: ['refs/cat.png'], wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.mode, 'i2i')
  assert.equal(value.images.length, 1)
  const upload = server.requests.filter(r => r.path === '/api/image/upload').at(-1)
  assert.match(upload.body, /name="file"/)
  const submitted = server.requests.filter(r => r.path === '/api/image/generate/async').at(-1)
  assert.match(submitted.body, /"mode":"i2i"/)
  assert.match(submitted.body, /"refImagePaths":\["image_studio\/uploads\/mock\/ref.png"\]/)
})

test('generate_video waits for the clip job and returns a public url', async () => {
  const value = await tools.get('va_studio_generate_video').execute(
    { prompt: '雨夜街头，女主回头', duration_sec: 5, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.status, 'done')
  assert.match(value.videoUrl, /\/api\/video\/clip\/files\//)
  assert.equal(value.path, 'video_clips/a.mp4')
  const submitted = server.requests.find(r => r.path === '/api/video/clip/generate/async')
  assert.match(submitted.body, /"mode":"t2v"/)
})

test('generate_video uploads a workspace image for image-to-video', async () => {
  const value = await tools.get('va_studio_generate_video').execute(
    { prompt: '让这只猫眨眼', image_path: 'refs/cat.png', wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.status, 'done')
  const submitted = server.requests.filter(r => r.path === '/api/video/clip/generate/async').at(-1)
  assert.match(submitted.body, /"mode":"i2v"/)
  assert.match(submitted.body, /"imagePath":"uploads\/ref.png"/)
})

test('produce_video refuses without explicit confirmation and reports mp4 when done', async () => {
  await assert.rejects(
    tools.get('va_studio_produce_video').execute({ project_id: 'proj-1', confirm: false }, exec()),
    /CONFIRM_REQUIRED/,
  )
  const value = await tools.get('va_studio_produce_video').execute(
    { project_id: 'proj-1', confirm: true, wait_seconds: 5 },
    exec(),
  )
  assert.equal(value.status, 'done')
  assert.equal(value.mp4Path, 'export/proj-1.mp4')
  assert.match(value.downloadUrl, /download\/mp4/)
})

test('reverse_prompt handles image URLs, video URLs and workspace files', async () => {
  const image = await tools.get('va_studio_reverse_prompt').execute(
    { source: 'image', url: 'https://example.com/cat.png' },
    exec(),
  )
  assert.match(image.plainTextPrompt, /黑猫/)
  assert.equal(image.imagePrompt.subject, '黑猫')

  const video = await tools.get('va_studio_reverse_prompt').execute(
    { source: 'video', url: 'https://example.com/rain.mp4', reverse_mode: 'drama', max_frames: 8 },
    exec(),
  )
  assert.match(video.plainTextPrompt, /雨夜/)
  assert.equal(video.shots[0].speaker, '女主')
  assert.equal(video.characters[0].name, '女主')
  const videoRequest = server.requests.filter(r => r.path === '/api/video/prompt-from-video').at(-1)
  assert.match(videoRequest.body, /"reverseMode":"drama"/)

  const file = await tools.get('va_studio_reverse_prompt').execute(
    { source: 'image', file_path: 'refs/cat.png' },
    exec(),
  )
  assert.match(file.plainTextPrompt, /黑猫/)
  const upload = server.requests.filter(r => r.path === '/api/video/prompt-from-image-file').at(-1)
  assert.match(upload.body, /name="file"/)
  assert.match(upload.body, /multipart\/form-data|Content-Disposition/)
})

test('reverse_prompt rejects files outside the workspace', async () => {
  await assert.rejects(
    tools.get('va_studio_reverse_prompt').execute({ source: 'image', file_path: '/etc/hosts' }, exec()),
    /FILE_NOT_FOUND|FILE_OUTSIDE_WORKSPACE/,
  )
})

test('job returns finished images for an image job', async () => {
  const value = await tools.get('va_studio_job').execute({ job_id: 'job-image', wait_seconds: 2 }, exec())
  assert.equal(value.status, 'done')
  assert.equal(value.jobType, 'image_studio')
  assert.equal(value.images.length, 1)
  assert.match(value.images[0].url, /\/api\/image\/files\//)
})

test('job polls an existing job and returns finished content', async () => {
  const value = await tools.get('va_studio_job').execute({ job_id: 'job-novel', wait_seconds: 2 }, exec())
  assert.equal(value.status, 'done')
  assert.equal(value.jobType, 'novel_generate')
  assert.match(value.markdown, /第二段正文/)
})
