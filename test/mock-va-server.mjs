/**
 * A tiny mock of the VA Studio backend, enough to exercise every plugin tool
 * without touching the real service or spending quota.
 *
 * Run standalone: `node test/mock-va-server.mjs` prints the URL and keeps
 * serving until Ctrl+C.
 */
import http from 'node:http'

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function text(res, body, type = 'text/markdown; charset=utf-8') {
  res.writeHead(200, { 'Content-Type': type })
  res.end(body)
}

async function readBody(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body
}

export async function startMockVa({ port = 0 } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const body = await readBody(req)
    requests.push({ method: req.method, path, authorization: req.headers.authorization || '', body })
    let data = {}
    try {
      data = body ? JSON.parse(body) : {}
    } catch {
      data = {}
    }

    if (path === '/api/drama/health') {
      return json(res, 200, {
        status: 'ok',
        maxVideoSeconds: 900,
        aiKeys: { llm_doubao: true, vision_doubao: true, t2v_seedance: true, tts_volc: true, t2i_seedream: true },
      })
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      if (data.password !== 'pw') return json(res, 401, { detail: '账号或密码错误' })
      return json(res, 200, { token: 'mock-token', expiresIn: 604800, username: 'tester' })
    }
    if (path === '/api/auth/me') {
      if (req.headers.authorization !== 'Bearer mock-token') return json(res, 401, { detail: '未登录或登录已过期' })
      return json(res, 200, {
        ok: true,
        id: 'user-1',
        username: 'tester',
        isAdmin: false,
        features: ['novel', 'screenplay', 'drama', 'video', 'reverse'],
      })
    }
    if (req.headers.authorization !== 'Bearer mock-token') {
      return json(res, 401, { detail: '未登录或登录已过期' })
    }

    if (path === '/api/prompt/expand' && req.method === 'POST') {
      return json(res, 200, { prompt: `扩写后的提示词：${data.text}`, notes: '', target: data.target, chars: 10 })
    }
    if (path === '/api/novel/records' && req.method === 'POST') {
      return json(res, 200, { item: { id: 'novel-1', title: data.title || '' } })
    }
    if (path === '/api/novel/stream' && req.method === 'POST') {
      if (String(data.idea || '').includes('积分不足')) {
        return json(res, 402, {
          code: 'INSUFFICIENT_POINTS',
          detail: '积分不足，请充值',
          requiredPoints: 100,
          availablePoints: 3,
        })
      }
      return json(res, 200, { jobId: 'job-novel', novelId: data.novelRecordId, status: 'queued', message: '排队中' })
    }
    if (path === '/api/novel/records/novel-1/markdown') {
      return text(res, '# 倒计时手表\n\n第一段正文。\n\n第二段正文。')
    }
    if (path === '/api/screenplay/stream' && req.method === 'POST') {
      if (data.sourceType === 'novel' && !data.novelId) return json(res, 422, { detail: [{ loc: ['body', 'novelId'], msg: '请提供小说' }] })
      return json(res, 200, { jobId: 'job-sp', screenplayId: 'sp-1' })
    }
    if (path === '/api/screenplay/records/sp-1') {
      return json(res, 200, {
        item: { title: '逆袭剧本', marketText: '# 第一集\n\n场次一。', standardText: '标准版', episodes: [{}, {}] },
        linkedDramas: [],
      })
    }
    if (path === '/api/drama/chat/jobs' && req.method === 'POST') {
      if (!data.message) return json(res, 400, { detail: 'message 不能为空' })
      return json(res, 200, { jobId: 'job-drama' })
    }
    if (path === '/api/drama/project/proj-1') {
      return json(res, 200, {
        project: {
          id: 'proj-1',
          title: '倒计时手表',
          status: 'ready',
          aspectRatio: '9:16',
          characters: [{ name: '男主' }, { name: '女主' }],
          shots: [
            { index: 1, shotSize: '中景', cameraMove: '推', durationSec: 5, plotDesc: '男主低头看表', dialogue: '快跑', speaker: '男主' },
            { index: 2, shotSize: '特写', cameraMove: '固定', durationSec: 5, plotDesc: '表盘倒计时归零', dialogue: '', speaker: '' },
          ],
        },
      })
    }
    if (path === '/api/image/upload' && req.method === 'POST') {
      return json(res, 200, { path: 'image_studio/uploads/mock/ref.png', mime: 'image/png', size: 4, filename: 'ref.png', kind: 'image' })
    }
    if (path === '/api/image/generate/async' && req.method === 'POST') {
      if (!data.prompt) return json(res, 400, { detail: '请填写图片描述' })
      return json(res, 200, { jobId: 'job-image' })
    }
    if (path === '/api/image/jobs/job-image') {
      return json(res, 200, {
        job: {
          id: 'job-image',
          type: 'image_studio',
          status: 'done',
          progress: 1,
          message: '完成',
          result: {
            items: [
              { index: 0, clientId: 'img-slot-0', status: 'done', progress: 1, message: '完成', error: '', result: { path: 'image_studio/outputs/x/gen_1.png', url: '/api/image/files/image_studio/outputs/x/gen_1.png', width: 1024, height: 1024, index: 0 } },
            ],
            results: [{ path: 'image_studio/outputs/x/gen_1.png', url: '/api/image/files/image_studio/outputs/x/gen_1.png', width: 1024, height: 1024, index: 0 }],
            errors: [],
            total: 1,
            current: 1,
          },
        },
      })
    }
    if (path === '/api/video/clip/generate/async' && req.method === 'POST') {
      return json(res, 200, { jobId: 'job-clip' })
    }
    if (path === '/api/video/clip/upload' && req.method === 'POST') {
      return json(res, 200, { path: 'uploads/ref.png', publicUrl: '/api/video/clip/files/uploads/ref.png' })
    }
    if (path === '/api/video/clip/jobs/job-clip') {
      return json(res, 200, {
        job: {
          type: 'video_clip',
          status: 'done',
          progress: 1,
          message: '完成',
          result: {
            items: [
              {
                index: 0,
                status: 'done',
                result: { taskId: 'task-1', videoUrl: '/api/video/clip/files/video_clips/a.mp4', path: 'video_clips/a.mp4' },
              },
            ],
            errors: [],
          },
        },
      })
    }
    if (path === '/api/drama/project/proj-1/autopilot' && req.method === 'POST') {
      return json(res, 200, { jobId: 'job-auto' })
    }
    if (path === '/api/video/prompt-from-image' || path === '/api/video/prompt-from-image-file') {
      return json(res, 200, {
        plainTextPrompt: '一只黑猫坐在雨夜霓虹灯下的窗台上，写实电影感',
        imagePrompt: { subject: '黑猫', style: '写实', lighting: '霓虹', composition: '中景', mood: '孤独', colorPalette: '蓝紫', details: '', negativeHints: '' },
        reverseMeta: { model: 'mock-vl' },
      })
    }
    if (path === '/api/video/prompt-from-video' || path === '/api/video/prompt-from-file') {
      return json(res, 200, {
        plainTextPrompt: '雨夜街头，女主回头看镜头',
        videoSpec: { title: '雨夜', durationSec: 5, shots: [{ index: 1, durationSec: 5, visual: '雨夜街头', dialogue: '等我', speaker: '女主' }] },
        productionPackage: { characters: [{ name: '女主' }], shotPrompts: [{ index: 1, prompt: '雨夜' }] },
        frameCount: 8,
        videoDurationSec: 5,
      })
    }
    if (path === '/api/drama/jobs/job-novel') {
      return json(res, 200, { job: { id: 'job-novel', type: 'novel_generate', status: 'done', progress: 1, message: '完成', result: { novelId: 'novel-1', title: '倒计时手表' } } })
    }
    if (path === '/api/drama/jobs/job-sp') {
      return json(res, 200, { job: { id: 'job-sp', type: 'screenplay_generate', status: 'done', progress: 1, message: '完成', result: { screenplayId: 'sp-1' } } })
    }
    if (path === '/api/drama/jobs/job-drama') {
      return json(res, 200, {
        job: {
          id: 'job-drama',
          type: 'storyboard',
          status: 'done',
          progress: 1,
          message: '分镜已完成',
          result: { projectId: 'proj-1', donePayload: { projectId: 'proj-1' } },
        },
      })
    }
    if (path === '/api/drama/jobs/job-auto') {
      return json(res, 200, {
        job: { id: 'job-auto', type: 'autopilot', projectId: 'proj-1', status: 'done', progress: 1, message: '完成', result: { mp4Path: 'export/proj-1.mp4', errors: [] } },
      })
    }
    return json(res, 404, { detail: 'Not Found' })
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMockVa({ port: Number(process.env.PORT || 0) })
  console.log(`mock VA Studio listening on ${server.url}`)
}
