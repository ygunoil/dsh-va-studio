import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { createSettings } from '../lib/settings.js'
import { jsonResponse, readJsonBody } from '../lib/errors.js'
import { registerTools } from '../lib/tools.js'

export const name = 'dsh-va-studio'
export const inject = ['connection', 'credentials', 'tools', 'skills', 'systemPrompt']
export const Config = Schema.object({})

export const SYSTEM_PROMPT_SECTION = 'tool:va-studio'
const UNCONFIGURED_PROMPT =
  'VA Studio 尚未配置。不要调用 va_studio_* 工具；引导用户打开「设置 → 插件 → VA Studio」填写后端地址和账号。不要在对话中索要密码或令牌。'
const CONFIGURED_PROMPT =
  'VA Studio 已配置。用户要生成短剧、视频、图片、小说、剧本，或从图片/视频反推提示词时，先加载 va-studio 或 va-studio-reverse-prompt 技能，再调用 va_studio_* 工具。生成会消耗真实额度：只在用户明确要求时调用，并先确认题材、篇幅与集数。'

const SKILLS = [
  {
    name: 'va-studio',
    description:
      'Generate short dramas, videos, novels and screenplays through the configured VA Studio backend. Use when the user asks to 生成短剧、写小说、写剧本、出片、视频生成, or wants a one-line idea turned into a production-ready story pack.',
    path: 'va-studio/SKILL.md',
  },
  {
    name: 'va-studio-reverse-prompt',
    description:
      'Reverse-engineer generation prompts from images or videos, and expand short prompts into production prompts, through the configured VA Studio backend. Use when the user asks for 提示词反推、看图写提示词、视频反推、扩写提示词.',
    path: 'va-studio-reverse-prompt/SKILL.md',
  },
]

function skillCandidate(skill) {
  const locator = new URL(`../skills/${skill.path}`, import.meta.url)
  return {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    locator,
    path: fileURLToPath(locator),
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`../skills/${skill.path.split('/')[0]}/`, import.meta.url)) },
  }
}

export function apply(ctx) {
  const settings = createSettings(ctx)

  const registerJson = (path, methods, fetch) => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })
  registerJson('/api/va-studio.settings', ['GET'], () => jsonResponse(() => settings.describe()))
  registerJson('/api/va-studio.save', ['POST'], request =>
    jsonResponse(async () => settings.save(await readJsonBody(request), request.signal)),
  )
  registerJson('/api/va-studio.test', ['POST'], request =>
    jsonResponse(async () => settings.test(await readJsonBody(request), request.signal)),
  )

  registerTools(ctx, settings)

  const candidates = SKILLS.map(skillCandidate)
  ctx.skills.registerProvider(() => ({
    name,
    list: async () => candidates,
    get: async selected => {
      const hit = candidates.find(candidate => candidate.name === selected.name)
      if (!hit) return undefined
      const body = await readFile(hit.locator, 'utf8')
      const content = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
      return { ...hit, content }
    },
  }))

  ctx.systemPrompt.section({ name: SYSTEM_PROMPT_SECTION, order: 118, text: UNCONFIGURED_PROMPT })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    let configured = false
    try {
      configured = await settings.isConfigured()
    } catch (error) {
      ctx.logger.info('va-studio: prompt assembly treated configuration as unset; code=%s', error?.code ?? 'UNKNOWN')
    }
    const assembly = await next()
    return {
      ...assembly,
      sections: assembly.sections.map(section =>
        section.name === SYSTEM_PROMPT_SECTION
          ? { ...section, text: configured ? CONFIGURED_PROMPT : UNCONFIGURED_PROMPT }
          : section,
      ),
    }
  })

  ctx.logger.info('va-studio: plugin mounted')
}
