/**
 * dsh-va-studio-example — 最小可加载的 DSH 0.2.1-rc.2 插件（Host / 服务端半）。
 *
 * 结构对齐 asar 内 0.2.1-rc.2 的插件约定：
 *   - 具名导出 `name` / `inject` / `Config` / `apply`；
 *   - 用 `defineTool` 声明工具，并 `ctx.tools.register()`；
 *   - 用 `ctx.connection.fetch.register()` 自注册一个给浏览器调用的 /api 端点；
 *   - 用 `ctx.systemPrompt.section()` 注入一小段固定提示；
 *   - 用 `ctx.skills.registerProvider()` 把一个随包分发的 SKILL.md 挂进技能目录。
 *
 * 参考来源：dsh-tools / dsh-client-connection / dsh-skill / dsh-system-prompt 的
 * README 与 lib/*.js，以及 dsh-desktop 仓库 packages/dsh-image-generation/index.js。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Loader 行内识别用的稳定插件名（建议与本包 package.json 的 name 一致）。 */
export const name = 'dsh-va-studio-example'

/**
 * 必需服务：缺失时插件保持等待（不会让整个 profile 崩）。
 * 可选服务（connection / skills）在 apply 内用 ctx.inject 懒挂载，
 * 这样在非 Web 组合里本插件依旧能加载。
 */
export const inject = ['tools', 'systemPrompt']

/** 配置 schema：cordis.patch.yml 里的 config 会先过这里。 */
export const Config = Schema.object({
  greeting: Schema.string().default('hello').description('Status 工具回显的问候语，用于验证 patch 里的 config 生效。'),
})

/** 系统提示分节的稳定名字，便于在 system-prompt/assemble 里按名字改写。 */
const STATUS_SECTION = 'tool:va-studio-example'

/** 工具返回的规范值（canonical value）；模型看到的内容由 output.render 投影。 */
function statusValue(exec, config) {
  return {
    ok: true,
    plugin: name,
    version: '0.0.1',
    greeting: config.greeting,
    // exec.agent?.session?.header.cwd 是会话工作区；也可在会话外调用，此时为 null。
    workspace: exec.agent?.session?.header?.cwd ?? null,
  }
}

/** 只读状态工具：一个参数、一个 object 输出、无副作用。 */
export function statusTool(ctx, config) {
  return defineTool({
    name: 'va_studio_status',
    description:
      'Return the VA Studio example plugin status: plugin name, version, configured greeting and the current session workspace. Read-only; call it when you need to confirm the plugin is mounted and its config was applied.',
    parameters: {
      verbose: { type: 'boolean', description: 'Include the resolved workspace path in the result text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Always true for a successful call.' },
          plugin: { type: 'string', required: true },
          version: { type: 'string', required: true },
          greeting: { type: 'string', required: true },
          // 单节点只接受一个 type；可空值用 exact-one 的 oneOf 表达。
          workspace: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Session cwd when known.' },
        },
      },
      // render 返回 ContentBlock[]；文本块最通用。图片需要 attachment 引用，见文档第 2.2 节。
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'read', title: 'Read VA Studio plugin status', rawInput: args }),
    async execute(args, exec) {
      // 合作式取消：必须观察 caller 的 signal。
      exec.signal?.throwIfAborted()
      ctx.logger.info('va-studio-example: status tool called; verbose=%s', String(args.verbose ?? false))
      return statusValue(exec, config)
    },
  })
}

/** 取出 SKILL.md 正文（去掉 YAML frontmatter）。 */
function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
}

/** 插件入口。 */
export function apply(ctx, config) {
  // 1) 工具：注册即进入模型可见工具集（工具 schema 由系统提示装配自动带上）。
  ctx.tools.register(statusTool(ctx, config))

  // 2) 系统提示：加到固定顺序位置，本示例只加一句路由说明。
  ctx.systemPrompt.section({
    name: STATUS_SECTION,
    order: 150,
    text: 'When the user asks whether the VA Studio plugin is loaded, call va_studio_status and report its version and greeting verbatim.',
  })

  // 3) 自注册浏览器可调的只读 HTTP 端点，路径必须位于 /api/ 之下。
  ctx.inject(['connection'], connCtx => {
    connCtx.effect(
      () =>
        connCtx.connection.fetch.register({
          path: '/api/va-studio-example.status',
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async request => {
            const verbose = new URL(request.url).searchParams.get('verbose') === '1'
            const value = { ok: true, plugin: name, version: '0.0.1', greeting: config.greeting, query: new URL(request.url).search.slice(1) }
            if (verbose) value.server = 'host'
            return Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
          },
        }),
      'va-studio-example: status fetch route',
    )
  })

  // 4) 技能：随包分发 skills/<name>/SKILL.md，并注册为技能提供者。
  ctx.inject(['skills'], skillCtx => {
    const locator = new URL('../skills/va-studio-example/SKILL.md', import.meta.url)
    const candidate = {
      name: 'va-studio-example',
      description: 'Check whether the VA Studio example plugin is mounted and read its configured greeting.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: name,
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      locator,
      resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/va-studio-example/', import.meta.url)) },
    }
    skillCtx.effect(
      () =>
        skillCtx.skills.registerProvider(() => ({
          name,
          list: async () => [candidate],
          get: async selected =>
            selected.name === candidate.name
              ? { ...candidate, content: stripFrontmatter(await readFile(locator, 'utf8')) }
              : undefined,
        })),
      'va-studio-example: skill provider',
    )
  })
}
