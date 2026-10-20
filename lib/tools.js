import { defineTool } from '@deepseek-ai/dsh-tools'
import { VaStudioError, safeError } from './errors.js'
import { clientFor } from './va-client.js'
import { mediaForm, readWorkspaceMedia } from './workspace.js'

const JOB_POLL_INTERVAL_MS = 2_500
const CONTENT_TIMEOUT_MS = 90_000

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new VaStudioError('ABORTED', '操作已取消。', 499))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new VaStudioError('ABORTED', '操作已取消。', 499))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })

function fail(error) {
  const safe = safeError(error)
  const wrapped = new Error(`[${safe.code}] ${safe.message}`)
  wrapped.cause = safe
  return wrapped
}

function short(text, limit = 120) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function outputFor(toText) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: toText(value) }],
  }
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function remainSeconds(deadline) {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

/** Try the three job registries in turn and remember the one that answered. */
async function fetchJob(client, jobId, signal, poller = {}) {
  const candidates = poller.kind
    ? [poller.kind]
    : ['drama', 'image', 'clip', 'reverse']
  const paths = {
    drama: id => `/api/drama/jobs/${encodeURIComponent(id)}`,
    image: id => `/api/image/jobs/${encodeURIComponent(id)}`,
    clip: id => `/api/video/clip/jobs/${encodeURIComponent(id)}`,
    reverse: id => `/api/video/prompt-reverse/jobs/${encodeURIComponent(id)}`,
  }
  for (const kind of candidates) {
    try {
      const data = await client.request(paths[kind](jobId), { signal, timeoutMs: 20_000 })
      poller.kind = kind
      const job = data?.job ?? data
      if (!job || typeof job !== 'object') throw new VaStudioError('PROTOCOL', '任务接口没有返回任务对象。', 502)
      return { job, kind }
    } catch (error) {
      if (poller.kind) throw error
      if (!(error instanceof VaStudioError) || error.httpStatus !== 404) throw error
    }
  }
  throw new VaStudioError('JOB_NOT_FOUND', `找不到任务 ${jobId}。`, 404)
}

async function waitJob(client, jobId, waitSeconds, signal, poller = {}) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  let last
  while (true) {
    last = await fetchJob(client, jobId, signal, poller)
    const status = String(last.job.status || '')
    if (['done', 'error', 'cancelled', 'canceled'].includes(status)) return last
    if (Date.now() >= deadline) return last
    await sleep(Math.min(JOB_POLL_INTERVAL_MS, Math.max(200, deadline - Date.now())), signal)
  }
}

async function jobContent(client, job, signal) {
  const type = String(job.type || '')
  const result = job.result || {}
  try {
    if (type === 'novel_generate') {
      const novelId = result.novelId || result.novelID
      if (!novelId) return undefined
      const markdown = await client.request(`/api/novel/records/${encodeURIComponent(novelId)}/markdown`, {
        signal,
        timeoutMs: CONTENT_TIMEOUT_MS,
      })
      return { kind: 'novel', novelId, markdown: typeof markdown === 'string' ? markdown : String(markdown ?? '') }
    }
    if (type === 'screenplay_generate') {
      const screenplayId = result.screenplayId
      if (!screenplayId) return undefined
      return { kind: 'screenplay', screenplayId, ...(await screenplayContent(client, screenplayId, signal)) }
    }
    if (type === 'storyboard') {
      const projectId = result.projectId || result.donePayload?.projectId
      if (!projectId) return undefined
      return { kind: 'drama', ...(await dramaContent(client, projectId, signal)) }
    }
  } catch (error) {
    if (error instanceof VaStudioError) return { kind: 'content-error', error: error.message }
    throw error
  }
  return undefined
}

async function screenplayContent(client, screenplayId, signal) {
  const data = await client.request(`/api/screenplay/records/${encodeURIComponent(screenplayId)}`, {
    signal,
    timeoutMs: CONTENT_TIMEOUT_MS,
  })
  const item = data?.item ?? {}
  return {
    screenplayId,
    title: item.title || '',
    marketText: item.marketText || '',
    standardText: item.standardText || '',
    episodeCount: Array.isArray(item.episodes) ? item.episodes.length : undefined,
  }
}

async function dramaContent(client, projectId, signal) {
  const data = await client.request(`/api/drama/project/${encodeURIComponent(projectId)}`, {
    signal,
    timeoutMs: CONTENT_TIMEOUT_MS,
  })
  return summarizeProject(data?.project, projectId)
}

function summarizeProject(project, fallbackId) {
  const shots = Array.isArray(project?.shots) ? project.shots : []
  const summarized = shots.map(shot => ({
    index: shot.index,
    shotSize: shot.shotSize || '',
    cameraMove: shot.cameraMove || '',
    durationSec: shot.durationSec,
    plotDesc: shot.plotDesc || '',
    dialogue: shot.dialogue || '',
    speaker: shot.speaker || '',
  }))
  const totalDurationSec = summarized.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0)
  return {
    projectId: project?.id || fallbackId,
    title: project?.title || '',
    status: project?.status || '',
    aspectRatio: project?.aspectRatio || '',
    shotCount: summarized.length,
    totalDurationSec: Math.round(totalDurationSec * 10) / 10,
    characters: (project?.characters || []).map(character => character.name).filter(Boolean),
    shots: summarized,
  }
}

function projectDisplay(value) {
  const lines = [
    `短剧项目：${value.title || '(未命名)'}`,
    `项目 ID：${value.projectId}`,
    `画幅：${value.aspectRatio || '9:16'} · 镜头：${value.shotCount} · 总时长：${value.totalDurationSec}s`,
    value.characters?.length ? `角色：${value.characters.join('、')}` : '',
    '',
  ].filter(Boolean)
  for (const shot of value.shots || []) {
    lines.push(
      `#${shot.index} [${shot.shotSize || '-'} · ${shot.cameraMove || '-'} · ${shot.durationSec || '-'}s] ${shot.plotDesc}`,
    )
    if (shot.dialogue) lines.push(`   ${shot.speaker ? `${shot.speaker}：` : ''}${shot.dialogue}`)
  }
  return lines.join('\n')
}

function extractImages(job, baseUrl) {
  const result = job?.result || {}
  const items = Array.isArray(result.items) ? result.items : []
  const done = items
    .filter(item => item && item.status === 'done' && item.result && typeof item.result === 'object')
    .map(item => item.result)
  const list = done.length ? done : Array.isArray(result.results) ? result.results : []
  return list
    .map(item => {
      const raw = String(item?.url || '')
      const url = raw ? (raw.startsWith('http') ? raw : `${baseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`) : ''
      return { url, path: item?.path || '', width: item?.width, height: item?.height, index: item?.index }
    })
    .filter(item => item.url)
}

function jobsHint(jobId) {
  return `任务仍在进行。可稍后调用 va_studio_job（jobId=${jobId}）继续等待或查看结果。`
}

function tool(meta) {
  return defineTool(meta)
}

export function registerTools(ctx, settings) {
  const tools = []

  async function connect(exec) {
    const conn = await settings.active()
    return clientFor(conn, { signal: exec?.signal })
  }

  tools.push(
    tool({
      name: 'va_studio_status',
      description:
        'Read the connected VA Studio backend status: health, logged-in user, feature permissions and which AI providers are configured. Safe and free. Call it before expensive generation when unsure whether the backend or a model is available.',
      parameters: {},
      output: outputFor(value =>
        [
          `VA Studio：${value.baseUrl}`,
          `连接：${value.health?.status === 'ok' ? '正常' : '异常'}`,
          `账号：${value.username || '-'}（${value.features?.join('、') || '无可见功能'}）`,
          value.aiSummary ? `已配置模型：${value.aiSummary}` : '',
          value.hint || '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        try {
          const conn = await settings.active()
          const client = clientFor(conn, { signal: exec.signal })
          const [health, me] = await Promise.all([
            client.request('/api/drama/health', { auth: false, signal: exec.signal, timeoutMs: 20_000 }),
            client.request('/api/auth/me', { signal: exec.signal, timeoutMs: 20_000 }),
          ])
          const aiKeys = health?.aiKeys || {}
          const ready = Object.entries(aiKeys)
            .filter(([key, value]) => value === true && /^(llm_|vision_|t2v_|video_|t2i_|tts_)/u.test(key))
            .map(([key]) => key)
          return {
            ok: true,
            baseUrl: conn.baseUrl,
            mode: conn.mode,
            username: me?.username || conn.username || '',
            features: Array.isArray(me?.features) ? me.features : [],
            isAdmin: Boolean(me?.isAdmin),
            health,
            aiSummary: ready.length ? ready.join('、') : '后端未暴露已配置模型',
            hint: ready.length ? '' : '后端健康检查没有看到已配置的模型，生成可能失败；请先在 VA Studio 管理端配置模型密钥。',
            display: '',
          }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_generate_novel',
      description:
        '生成小说 Generate a novel through VA Studio. Creates a novel record first, submits the generation job, waits up to wait_seconds, and returns the full markdown when finished. Costs real quota. Ask the user for the premise and length before calling.',
      parameters: {
        idea: { type: 'string', required: true, description: '一句话创意 / 故事梗概。' },
        title: { type: 'string', description: '书名，留空则由 VA Studio 生成。' },
        chapters: { type: 'integer', description: '章节数，默认 1，尽量只生成用户需要的量。' },
        words_per_chapter: { type: 'integer', description: '每章字数，最少 1000，默认 1000。' },
        work_mode: { type: 'string', enum: ['short', 'medium', 'serial'], description: 'short=短篇（默认），medium=中篇，serial=长篇连载。' },
        platform: { type: 'string', enum: ['fanqie', 'zhihu', 'qidian'], description: '投放平台风格，默认 fanqie。' },
        style: { type: 'string', description: '写作风格 key，默认 balanced。' },
        story_pattern: {
          type: 'string',
          enum: ['general', 'shuang', 'shiqing', 'sweet', 'angst', 'regret', 'suspense', 'dead_protagonist'],
          description: '故事模型，默认 general。',
        },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 120，最大 600；超时后返回 jobId 供继续轮询。' },
      },
      output: outputFor(value =>
        value.markdown
          ? `小说《${value.title || ''}》（${value.chars} 字，novelId=${value.novelId}）\n\n${value.markdown}`
          : `小说生成任务已提交：jobId=${value.jobId}，novelId=${value.novelId}。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 700_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const title = String(args.title || '').trim() || String(args.idea).trim().slice(0, 24)
          const chapters = clamp(args.chapters, 1, 200, 1)
          const words = clamp(args.words_per_chapter, 1000, 8000, 1000)
          const created = await client.request('/api/novel/records', {
            method: 'POST',
            body: { title, chapters, wordsPerChapter: words, status: 'generating' },
            signal: exec.signal,
            timeoutMs: 30_000,
          })
          const novelId = created?.item?.id
          if (!novelId) throw new VaStudioError('PROTOCOL', '创建小说记录失败：响应缺少记录 ID。', 502)
          const submitted = await client.request('/api/novel/stream', {
            method: 'POST',
            body: {
              idea: String(args.idea),
              title,
              chapters,
              wordsPerChapter: words,
              workMode: args.work_mode || 'short',
              platform: args.platform || 'fanqie',
              style: args.style || 'balanced',
              storyPattern: args.story_pattern || 'general',
              fastMode: true,
              submissionReview: false,
              autoContinue: true,
              novelRecordId: novelId,
            },
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          if (!jobId) throw new VaStudioError('PROTOCOL', '小说生成响应缺少 jobId。', 502)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 120), exec.signal)
          if (waited.job.status !== 'done') {
            return {
              novelId,
              jobId,
              status: waited.job.status,
              progress: waited.job.progress,
              message: waited.job.message || '',
              pending: waited.job.status !== 'error',
              display: '',
            }
          }
          const markdown = await client.request(`/api/novel/records/${encodeURIComponent(novelId)}/markdown`, {
            signal: exec.signal,
            timeoutMs: CONTENT_TIMEOUT_MS,
          })
          const text = typeof markdown === 'string' ? markdown : String(markdown ?? '')
          return {
            novelId,
            jobId,
            status: 'done',
            title: waited.job.result?.title || title,
            chars: text.length,
            markdown: text,
            display: '',
          }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_generate_screenplay',
      description:
        '生成剧本 Generate a short-drama screenplay from an idea or an existing novel. Submits a VA Studio screenplay job, waits up to wait_seconds, and returns the market screenplay text. Costs real quota.',
      parameters: {
        idea: { type: 'string', description: '一句话创意；与 novel_id 二选一。' },
        novel_id: { type: 'string', description: '用 VA Studio 里已有小说改编时传小说记录 ID。' },
        title: { type: 'string', description: '剧本标题。' },
        episode_count: { type: 'integer', description: '集数，默认 3。' },
        duration_seconds: { type: 'integer', description: '单集时长秒数，默认 60。' },
        platform: { type: 'string', description: '平台风格，默认 短视频。' },
        genre: { type: 'string', description: '题材。' },
        style: { type: 'string', description: '风格。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 120，最大 600。' },
      },
      output: outputFor(value =>
        value.marketText
          ? `剧本《${value.title || ''}》（screenplayId=${value.screenplayId}，${value.episodeCount ?? '-'} 集）\n\n${value.marketText}`
          : `剧本生成任务已提交：jobId=${value.jobId}，screenplayId=${value.screenplayId}。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 700_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const idea = String(args.idea || '').trim()
          const novelId = String(args.novel_id || '').trim()
          if (!idea && !novelId) throw new VaStudioError('INVALID_ARGUMENT', '请提供 idea 或 novel_id。', 400)
          const client = await connect(exec)
          const submitted = await client.request('/api/screenplay/stream', {
            method: 'POST',
            body: {
              sourceType: novelId ? 'novel' : 'idea',
              idea,
              novelId,
              title: String(args.title || ''),
              genre: String(args.genre || ''),
              style: String(args.style || ''),
              platform: String(args.platform || '短视频'),
              episodeCount: clamp(args.episode_count, 1, 500, 3),
              durationSeconds: clamp(args.duration_seconds, 1, 86_400, 60),
            },
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          const screenplayId = submitted?.screenplayId
          if (!jobId) throw new VaStudioError('PROTOCOL', '剧本生成响应缺少 jobId。', 502)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 120), exec.signal)
          if (waited.job.status !== 'done') {
            return {
              screenplayId,
              jobId,
              status: waited.job.status,
              progress: waited.job.progress,
              message: waited.job.message || '',
              pending: waited.job.status !== 'error',
              display: '',
            }
          }
          const content = await screenplayContent(client, screenplayId, exec.signal)
          return { ...content, jobId, status: 'done', display: '' }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_generate_drama',
      description:
        '生成短剧分镜 Turn one-line story ideas into a VA Studio short-drama project with shots (AIGC storyboard). Waits up to wait_seconds, then returns a compact shot list and project id. Does not render video; call va_studio_produce_video for that. Costs real quota.',
      parameters: {
        idea: { type: 'string', required: true, description: '一句话剧情 / 用户消息。' },
        target_duration_sec: { type: 'integer', description: '目标总时长秒数，默认 60。' },
        user_requirement: { type: 'string', description: '硬性要求，例如画风、真人/动漫、前三秒钩子、结尾反转。' },
        visual_style: { type: 'string', description: '视觉风格，例如 写实电影感、国漫、赛博朋克。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 120，最大 600。' },
      },
      output: outputFor(value =>
        value.shots
          ? projectDisplay(value)
          : `短剧分镜任务已提交：jobId=${value.jobId}。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 700_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const submitted = await client.request('/api/drama/chat/jobs', {
            method: 'POST',
            body: {
              message: String(args.idea),
              userRequirement: String(args.user_requirement || ''),
              visualStyle: String(args.visual_style || ''),
              targetDurationSec: clamp(args.target_duration_sec, 0, 900, 60),
              fastMode: true,
              originType: 'idea',
            },
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          if (!jobId) throw new VaStudioError('PROTOCOL', '短剧生成响应缺少 jobId。', 502)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 120), exec.signal)
          const projectId = waited.job.result?.projectId || waited.job.result?.donePayload?.projectId
          if (waited.job.status !== 'done') {
            return {
              projectId: projectId || '',
              jobId,
              status: waited.job.status,
              progress: waited.job.progress,
              message: waited.job.message || '',
              pending: waited.job.status !== 'error',
              display: '',
            }
          }
          if (!projectId) throw new VaStudioError('PROTOCOL', '分镜任务完成但没有返回项目 ID。', 502)
          const summary = await dramaContent(client, projectId, exec.signal)
          return { ...summary, jobId, status: 'done', display: '' }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_generate_video',
      description:
        '生成单条视频 Generate one short video clip (4-30s) from a text prompt, or animate a workspace image (image-to-video) using VA Studio. Waits up to wait_seconds and returns a public video URL. Costs real quota; confirm with the user first.',
      parameters: {
        prompt: { type: 'string', required: true, description: '视频画面提示词，包含主体、动作、镜头、光线、氛围。' },
        duration_sec: { type: 'integer', description: '时长 4-30 秒，默认 5。' },
        aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: '画幅，默认 9:16。' },
        resolution: { type: 'string', enum: ['720P', '1080P'], description: '分辨率，默认 1080P。' },
        image_path: { type: 'string', description: '工作区内的图片路径；传了就走图生视频，不传是文生视频。' },
        generate_audio: { type: 'boolean', description: '是否生成音频，默认 true。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 300，最大 600。' },
      },
      output: outputFor(value =>
        value.videoUrl
          ? `视频已生成（${value.durationSec || '-'}s）：${value.videoUrl}\n任务：${value.jobId}${value.path ? `\n存储路径：${value.path}` : ''}`
          : `视频生成任务已提交：jobId=${value.jobId}。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 700_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const body = {
            mode: 't2v',
            provider: 'seedance',
            prompt: String(args.prompt),
            aspectRatio: args.aspect_ratio || '9:16',
            resolution: args.resolution || '1080P',
            durationSec: clamp(args.duration_sec, 4, 30, 5),
            promptExtend: true,
            audioMode: 'auto',
            generateCount: 1,
            pollMaxSeconds: 1800,
            generateAudio: args.generate_audio !== false,
            outputFormat: 'mp4',
          }
          if (args.image_path) {
            const file = await readWorkspaceMedia(exec, String(args.image_path), { kind: 'image' })
            const form = await mediaForm(file)
            const uploaded = await client.request('/api/video/clip/upload', {
              method: 'POST',
              form,
              signal: exec.signal,
              timeoutMs: 120_000,
            })
            if (!uploaded?.path) throw new VaStudioError('PROTOCOL', '图片上传失败：响应缺少 path。', 502)
            body.mode = 'i2v'
            body.imagePath = uploaded.path
          }
          const submitted = await client.request('/api/video/clip/generate/async', {
            method: 'POST',
            body,
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          if (!jobId) throw new VaStudioError('PROTOCOL', '视频生成响应缺少 jobId。', 502)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 300), exec.signal, { kind: 'clip' })
          const item = waited.job.result?.items?.[0]?.result || waited.job.result?.results?.[0]
          if (waited.job.status !== 'done') {
            return {
              jobId,
              status: waited.job.status,
              progress: waited.job.progress,
              message: waited.job.message || '',
              pending: waited.job.status !== 'error',
              display: '',
            }
          }
          if (!item?.videoUrl) {
            const error = waited.job.result?.errors?.[0]?.error || item?.error || '视频任务完成但没有返回视频地址。'
            throw new VaStudioError('VIDEO_FAILED', error, 502)
          }
          return {
            jobId,
            status: 'done',
            videoUrl: item.videoUrl,
            path: item.path || '',
            durationSec: body.durationSec,
            mode: body.mode,
            display: '',
          }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_generate_image',
      description:
        '生成图片 Generate one or more images through VA Studio (text-to-image, or image-to-image when workspace reference images are supplied). Returns public image URLs and saved storage paths. Costs real quota; confirm with the user first.',
      parameters: {
        prompt: { type: 'string', required: true, description: '图片描述：主体、场景、构图、光线、风格。' },
        negative_prompt: { type: 'string', description: '不希望出现的内容。' },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '9:16', '16:9', '3:4', '4:3', '2:3', '3:2', '21:9'],
          description: '画幅，默认 1:1。',
        },
        resolution: { type: 'string', enum: ['1K', '2K', '4K'], description: '分辨率，默认 2K。' },
        count: { type: 'integer', description: '生成张数 1-4，默认 1。' },
        style: { type: 'string', description: '风格描述，例如 精致写实、日系插画、国风。' },
        model: { type: 'string', description: '可选：指定生图模型 ID，留空用 VA Studio 默认。' },
        reference_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '图生图参考图，当前会话工作区内的图片路径，最多 9 张。传了即走图生图。',
        },
        prompt_extend: { type: 'boolean', description: '是否自动补全清晰度/光影/材质描述，默认 true。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 120，最大 600。' },
      },
      output: outputFor(value =>
        value.images?.length
          ? `图片已生成（${value.images.length} 张，${value.mode === 'i2i' ? '图生图' : '文生图'}）：
${value.images.map(image => `- ${image.url}${image.width ? `（${image.width}×${image.height}）` : ''}`).join('\n')}`
          : `图片生成任务已提交：jobId=${value.jobId}。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 700_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const prompt = String(args.prompt || '').trim()
          if (!prompt) throw new VaStudioError('INVALID_ARGUMENT', '请填写图片描述。', 400)
          const referencePaths = Array.isArray(args.reference_paths)
            ? args.reference_paths.map(value => String(value)).filter(Boolean)
            : []
          if (referencePaths.length > 9) {
            throw new VaStudioError('INVALID_ARGUMENT', '参考图最多 9 张。', 400)
          }
          const uploaded = []
          for (const referencePath of referencePaths) {
            const file = await readWorkspaceMedia(exec, referencePath, { kind: 'image', maxBytes: 12 * 1024 * 1024 })
            const form = await mediaForm(file)
            const saved = await client.request('/api/image/upload', {
              method: 'POST',
              form,
              signal: exec.signal,
              timeoutMs: 120_000,
            })
            if (!saved?.path) throw new VaStudioError('PROTOCOL', '参考图上传失败：响应缺少 path。', 502)
            uploaded.push(saved.path)
          }
          const body = {
            mode: uploaded.length ? 'i2i' : 't2i',
            prompt,
            negativePrompt: String(args.negative_prompt || ''),
            aspectRatio: args.aspect_ratio || '1:1',
            resolution: args.resolution || '2K',
            promptExtend: args.prompt_extend !== false,
            generateCount: clamp(args.count, 1, 4, 1),
            style: String(args.style || ''),
            model: String(args.model || ''),
            refImagePaths: uploaded,
          }
          const submitted = await client.request('/api/image/generate/async', {
            method: 'POST',
            body,
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          if (!jobId) throw new VaStudioError('PROTOCOL', '图片生成响应缺少 jobId。', 502)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 120), exec.signal, { kind: 'image' })
          if (waited.job.status !== 'done') {
            return {
              jobId,
              status: waited.job.status,
              progress: waited.job.progress,
              message: waited.job.message || '',
              pending: waited.job.status !== 'error',
              display: '',
            }
          }
          const images = extractImages(waited.job, client.baseUrl)
          if (!images.length) {
            const errors = waited.job.result?.errors || []
            const detail = errors.map(item => (typeof item === 'string' ? item : item?.error || item?.message)).filter(Boolean).join('; ')
            throw new VaStudioError('IMAGE_FAILED', detail || '图片任务完成但没有返回图片地址。', 502)
          }
          return { jobId, status: 'done', mode: body.mode, prompt, images, display: '' }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_produce_video',
      description:
        '短剧一键成片 Start VA Studio autopilot for an existing short-drama project: character refs, keyframes, shot videos, dubbing and final compose. Very expensive and slow (minutes to tens of minutes). Requires confirm=true after the user explicitly approves. Returns a jobId immediately unless wait_seconds is set.',
      parameters: {
        project_id: { type: 'string', required: true, description: '短剧项目 ID。' },
        confirm: { type: 'boolean', required: true, description: '用户已明确同意付费出片时传 true。' },
        skip_dubbing: { type: 'boolean', description: '跳过配音。' },
        skip_compose: { type: 'boolean', description: '跳过最终压片。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 0（立即返回任务）。' },
      },
      output: outputFor(value =>
        value.mp4Path
          ? `成片已完成：${value.mp4Path}\njobId=${value.jobId}${value.errors?.length ? `\n告警：${value.errors.map(item => (typeof item === 'string' ? item : item?.error || item?.message || JSON.stringify(item))).join('; ')}` : ''}`
          : `出片任务已启动：jobId=${value.jobId}（项目 ${value.projectId}）。${value.pending ? jobsHint(value.jobId) : ''}`,
      ),
      timeoutMs: 660_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try {
          if (args.confirm !== true) {
            throw new VaStudioError(
              'CONFIRM_REQUIRED',
              '一键成片会消耗大量时间和积分。必须先向用户确认，再以 confirm=true 调用。',
              400,
            )
          }
          const client = await connect(exec)
          const projectId = String(args.project_id)
          const submitted = await client.request(`/api/drama/project/${encodeURIComponent(projectId)}/autopilot`, {
            method: 'POST',
            body: {
              skipDubbing: Boolean(args.skip_dubbing),
              skipCompose: Boolean(args.skip_compose),
              generateCharacterRefs: true,
              generateSceneRefs: true,
              requireAssetRefs: 'warn',
            },
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          const jobId = submitted?.jobId
          if (!jobId) throw new VaStudioError('PROTOCOL', '出片响应缺少 jobId。', 502)
          const waitSeconds = clamp(args.wait_seconds, 0, 600, 0)
          if (!waitSeconds) {
            return { projectId, jobId, status: submitted?.status || 'queued', pending: true, display: '' }
          }
          const waited = await waitJob(client, jobId, waitSeconds, exec.signal)
          return {
            projectId,
            jobId,
            status: waited.job.status,
            pending: waited.job.status !== 'done' && waited.job.status !== 'error',
            mp4Path: waited.job.result?.mp4Path || '',
            errors: Array.isArray(waited.job.result?.errors) ? waited.job.result.errors : [],
            downloadUrl: `/api/drama/project/${encodeURIComponent(projectId)}/download/mp4`,
            display: '',
          }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_reverse_prompt',
      description:
        '提示词反推 Reverse-engineer a generation prompt from an image or a video through VA Studio. Provide an http(s) url or a file inside the session workspace. Image mode returns a prompt plus structured fields; video mode returns a prompt, shot spec and (drama mode) a production package. Costs quota for long videos.',
      parameters: {
        source: { type: 'string', required: true, enum: ['image', 'video'], description: 'image 或 video。' },
        url: { type: 'string', description: '图片/视频的 http(s) 直链，与 file_path 二选一。' },
        file_path: { type: 'string', description: '当前会话工作区内的本地文件路径，与 url 二选一。' },
        user_hint: { type: 'string', description: '反推偏好，例如“关注运镜和光影”“输出英文提示词”。' },
        reverse_mode: { type: 'string', enum: ['visual', 'drama'], description: '视频反推模式：visual=视觉提示词（默认），drama=短剧分镜+台词。' },
        max_frames: { type: 'integer', description: '视频抽帧数 3-30，默认 8。' },
      },
      output: outputFor(value => {
        const lines = [value.plainTextPrompt || '(没有返回提示词)']
        if (value.imagePrompt && typeof value.imagePrompt === 'object') {
          const entries = Object.entries(value.imagePrompt).filter(([, v]) => v)
          if (entries.length) lines.push('', '结构化字段：', ...entries.map(([k, v]) => `- ${k}: ${v}`))
        }
        if (Array.isArray(value.shots) && value.shots.length) {
          lines.push('', `分镜（${value.shots.length} 条）：`)
          for (const shot of value.shots) {
            lines.push(`#${shot.index} ${shot.durationSec || '-'}s ${shot.visual || ''}`)
            if (shot.dialogue) lines.push(`   ${shot.speaker ? `${shot.speaker}：` : ''}${shot.dialogue}`)
          }
        }
        if (value.characters?.length) {
          lines.push('', `角色：${value.characters.map(c => c.name).filter(Boolean).join('、')}`)
        }
        return lines.join('\n')
      }),
      timeoutMs: 420_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const source = args.source === 'video' ? 'video' : 'image'
          const url = String(args.url || '').trim()
          const filePath = String(args.file_path || '').trim()
          if (!url && !filePath) throw new VaStudioError('INVALID_ARGUMENT', '请提供 url 或 file_path。', 400)
          if (url && filePath) throw new VaStudioError('INVALID_ARGUMENT', 'url 和 file_path 只能提供一个。', 400)
          const client = await connect(exec)
          const userHint = String(args.user_hint || '')
          let data
          if (url) {
            if (!/^https?:\/\//iu.test(url)) throw new VaStudioError('INVALID_ARGUMENT', 'url 必须是 http(s) 直链。', 400)
            data =
              source === 'image'
                ? await client.request('/api/video/prompt-from-image', {
                    method: 'POST',
                    body: { imageUrl: url, userHint },
                    signal: exec.signal,
                    timeoutMs: 90_000,
                  })
                : await client.request('/api/video/prompt-from-video', {
                    method: 'POST',
                    body: {
                      videoUrl: url,
                      userHint,
                      reverseMode: args.reverse_mode === 'drama' ? 'drama' : 'visual',
                      maxFrames: clamp(args.max_frames, 3, 30, 8),
                    },
                    signal: exec.signal,
                    timeoutMs: 330_000,
                  })
          } else {
            const file = await readWorkspaceMedia(exec, filePath, { kind: source })
            const form = await mediaForm(file, {
              userHint,
              ...(source === 'video'
                ? {
                    reverseMode: args.reverse_mode === 'drama' ? 'drama' : 'visual',
                    maxFrames: clamp(args.max_frames, 3, 30, 8),
                  }
                : {}),
            })
            data = await client.request(
              source === 'image' ? '/api/video/prompt-from-image-file' : '/api/video/prompt-from-file',
              { method: 'POST', form, signal: exec.signal, timeoutMs: source === 'video' ? 330_000 : 90_000 },
            )
          }
          const videoSpec = data?.videoSpec || {}
          return {
            ok: true,
            source,
            plainTextPrompt: data?.plainTextPrompt || '',
            imagePrompt: data?.imagePrompt || undefined,
            videoSpec,
            shots: Array.isArray(videoSpec.shots) ? videoSpec.shots : undefined,
            videoPrompt: data?.videoPrompt || undefined,
            characters: data?.productionPackage?.characters,
            shotPrompts: data?.productionPackage?.shotPrompts,
            frameCount: data?.frameCount,
            videoDurationSec: data?.videoDurationSec,
            reverseMeta: data?.reverseMeta,
            display: '',
          }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_expand_prompt',
      description:
        '扩写提示词 Expand a short Chinese idea into a production-ready image or video prompt through VA Studio. Cheap and fast; use before generation when the user gives only a few words.',
      parameters: {
        text: { type: 'string', required: true, description: '原始短提示词或一句话描述。' },
        target: { type: 'string', enum: ['image', 'video'], description: '扩写目标，默认 image。' },
        style_hint: { type: 'string', description: '风格提示，例如 写实电影感、国风水墨。' },
        max_chars: { type: 'integer', description: '提示词最大字符数 200-4000，默认 1000。' },
      },
      output: outputFor(value => value.prompt || '(没有返回提示词)'),
      timeoutMs: 90_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const data = await client.request('/api/prompt/expand', {
            method: 'POST',
            body: {
              text: String(args.text),
              target: args.target === 'video' ? 'video' : 'image',
              styleHint: String(args.style_hint || ''),
              maxChars: clamp(args.max_chars, 200, 4000, 1000),
            },
            signal: exec.signal,
            timeoutMs: 60_000,
          })
          return { ok: true, prompt: data?.prompt || '', notes: data?.notes || '', chars: data?.chars || 0, display: '' }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  tools.push(
    tool({
      name: 'va_studio_job',
      description:
        '查询任务 Poll a VA Studio job by id (novel, screenplay, drama storyboard, video clip, autopilot or prompt reverse). Optionally waits up to wait_seconds and, when the job is done, returns the finished novel/screenplay/project content. Use it after a generation tool returned pending.',
      parameters: {
        job_id: { type: 'string', required: true, description: '任务 ID。' },
        wait_seconds: { type: 'integer', description: '等待完成的秒数，默认 60，最大 600。' },
        include_content: { type: 'boolean', description: '完成后是否取回正文/分镜，默认 true。' },
      },
      output: outputFor(value => {
        const head = `任务 ${value.jobId}：${value.status}${value.progress !== undefined ? `（${Math.round(Number(value.progress) * 100)}%）` : ''}${value.message ? ` · ${value.message}` : ''}`
        if (value.marketText) return `${head}\n\n${value.marketText}`
        if (value.markdown) return `${head}\n\n${value.markdown}`
        if (value.shots) return `${head}\n\n${projectDisplay(value)}`
        if (value.videoUrl) return `${head}\n\n视频：${value.videoUrl}`
        if (value.images?.length) return `${head}\n\n图片：\n${value.images.map(image => `- ${image.url}`).join('\n')}`
        if (value.plainTextPrompt) return `${head}\n\n${value.plainTextPrompt}`
        return `${head}${value.pending ? `\n${jobsHint(value.jobId)}` : ''}`
      }),
      timeoutMs: 660_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const client = await connect(exec)
          const jobId = String(args.job_id)
          const waited = await waitJob(client, jobId, clamp(args.wait_seconds, 0, 600, 60), exec.signal)
          const base = {
            jobId,
            jobType: waited.job.type || '',
            status: waited.job.status,
            progress: waited.job.progress,
            message: waited.job.message || '',
            pending: !['done', 'error', 'cancelled', 'canceled'].includes(String(waited.job.status)),
            display: '',
          }
          if (base.status !== 'done' || args.include_content === false) return base
          const type = String(waited.job.type || '')
          const result = waited.job.result || {}
          if (type === 'video_clip') {
            const item = result.items?.[0]?.result || result.results?.[0]
            return { ...base, videoUrl: item?.videoUrl || '', path: item?.path || '', durationSec: item?.durationSec }
          }
          if (type === 'prompt_reverse') {
            const item = result.items?.[0]?.result || result.results?.[0] || {}
            return {
              ...base,
              plainTextPrompt: item.plainTextPrompt || '',
              shots: item.videoSpec?.shots,
              imagePrompt: item.imagePrompt,
            }
          }
          if (type === 'image_studio') {
            return { ...base, images: extractImages(waited.job, client.baseUrl) }
          }
          if (type === 'autopilot') {
            const projectId = waited.job.projectId
            return {
              ...base,
              mp4Path: result.mp4Path || '',
              errors: Array.isArray(result.errors) ? result.errors : [],
              downloadUrl: projectId ? `/api/drama/project/${encodeURIComponent(projectId)}/download/mp4` : '',
            }
          }
          const content = await jobContent(client, waited.job, exec.signal)
          return { ...base, ...(content || {}) }
        } catch (error) {
          throw fail(error)
        }
      },
    }),
  )

  for (const definition of tools) ctx.tools.register(definition)
  return tools
}
