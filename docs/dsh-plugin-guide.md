# DeepSeek Harness 0.2.1-rc.2 第三方插件开发与安装指南

> 目标机器事实（本文所有结论的基线）
>
> - 应用：`/Applications/DeepSeek Harness.app`，Info.plist `CFBundleName = DeepSeek Harness`、`CFBundleShortVersionString = 0.2.1-rc.2`、`CFBundleIdentifier = com.deepseek.dsh`。
> - 它是 Electron 壳（`app.asar/package.json` 的 name 为 `@deepseek-ai/dsh-desktop`，version `0.2.1-rc.2`）+ 内置 Harness runtime（`app.asar/dsh/`，`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.2）。
> - Info.plist 实测版本、asar 根 `package.json` 实测版本，二者一致。
> - 运行中的 profile：`~/.dsh/profiles/desktop/`（Electron 独占）。asar 里**没有** `dsh-image-generation` 等 Desktop 产品插件（`asar list | grep dsh-image-generation` 命中 0），所以本地 `项目/dsh-desktop` checkout 里的 `packages/dsh-image-generation` 只能当**协议参考**，不能假定其服务在本机存在。
> - 本文标注约定：**【实测】**＝本次实际运行并观察到的结果；**【读码】**＝从 asar 内代码/README 读到的事实；**【推断】**＝由事实推出但未端到端验证；**【未验证】**＝需要安装/重启/真实会话才能确认。

---

## 0. TL;DR（先看这 8 条）

1. 插件就是一个普通 npm 包：`package.json` 里 `main`/`exports` 指向 Host 半，`exports["./client"]` 指向浏览器半，`dsh.bundle.patch` 指向随包的 `cordis.patch.yml`，`dsh.client.platform = "web"` 声明有浏览器半。**【读码】**（`dsh-package-manifest` 类型、`dsh-client-modules/lib/index.js:172`）。
2. Host 半是 Cordis 插件：具名导出 `name` / `inject` / `Config` / `apply`。工具用 `@deepseek-ai/dsh-tools` 的 `defineTool()` 定义后 `ctx.tools.register()`。**【读码】+【实测】**（示例插件在临时 profile 中成功加载）。
3. 插件要调用 Harness 服务（tools / skills / systemPrompt / connection / credentials / attachments…）**不需要**在 npm 里装这些包：launcher 会安装一份「runtime resolution」，把 `@deepseek-ai/*` 从当前安装解析。**前提是插件已安装进 profile 的 `node_modules`**；用绝对文件路径临时 insert 的插件享受不到这个映射（实测：`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`）。
4. 浏览器半可以是**手写单文件 `client.js`**，不需要构建工具、不需要 JSX，协议是 `window.__ModuleLoader__.load({ id, factory(require) {...} })`；`require` 只能命中 11 个平台基线模块（见 §3.2）。**【读码】+【实测】**（离线 harness 校验通过）。
5. 给 UI 加设置页签：`ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name, id, order, locale, label }, Component))`。只做设置页**不需要** `uiConversation`。**【读码】+【实测】**。
6. 官方 CLI 是应用内的 `runtime/cli/bin/dsh`（`dsh` 不在 PATH 上）。`dsh plugin --profile desktop add <绝对路径目录|.tgz|包名@版本>` 是由 Desktop 安装包授权的管理入口；`--dump-config` 等 boot/dump 命令对 `desktop` 会被拒绝。**【实测】**。
7. 安装进 profile 后，**CLI 的 `dsh plugin add` 实测会自动把 bundle 追加到 `dsh.profile.bundles`（即自动启用）**；Web GUI 的 Plugins 页安装完成页另有 **Enable now**（UI 是否已在安装时先行启用未验证，以卡片状态为准）。**【实测/读码】**。
8. 安装/启用失败的回滚：应用启动失败对话框里有「禁用第三方插件、备份 profile patch 并重启」；也可以退出应用后手改 `~/.dsh/profiles/desktop/package.json` 的 bundles 列表 / 跑 `dsh plugin --profile desktop remove`。**【读码】+【实测】**（CLI 拒绝 desktop dump、插件命令可转发）。

---

## 1. 包结构

### 1.1 package.json 字段

以 asar 内官方包 + 本地 image-generation 参考 + 本次示例插件三方对照。示例见 `docs/example-plugin/package.json`。

| 字段 | 必需性 | 说明 | 来源 |
|---|---|---|---|
| `name` | 必需 | 插件包名。**bundle 的 `cordis.patch.yml` 里 `insert[].name` 默认就写这个包名**；client boot graph 的 `id` 也是它。 | asar: `dsh-client-modules/lib/index.js:172`；`dsh-package-manifest/lib/types/types.d.ts` |
| `version` | 必需 | 兼容性检查、Plugins 页展示、update 判定都用它。 | `dsh-package-manifest` |
| `type` | 强烈建议 `"module"` | Host 半用 ESM（官方插件全是 `type: module`）；client bundle 是普通脚本，不受影响。 | asar 各包 package.json |
| `main` | 必需（Host 半入口） | 例如 `./dsh/index.js`；也可用 `exports["."]`。 | asar 各包 |
| `exports` | 建议 | 至少要有 `"."`、`"./client"`、`"./package.json"`（有的包还有 `"./cordis.patch.yml"`）。`exports["./client"]` 必须是字符串或带 `default` 字符串的对象；缺失时宿主会报 “client bundle not found”。 | `dsh-client-modules/lib/index.js:171-181` |
| `files` | 建议 | 控制 `npm pack` 内容；**别把 `dsh` 目录漏掉**。 | npm 语义 |
| `engines.dsh` | **强烈建议** | SemVer range，声明兼容的 DSH 版本。**一旦声明，`peerDependencies` 的 DSH 兼容检查被完全忽略**，只按它判定。 | `dsh-app-boot/README.md` §Profiles（“When the manifest declares engines.dsh, that range alone decides…”） |
| `peerDependencies` | 可选 | 仅当**没有** `engines.dsh` 时才逐条校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 range（含 prerelease 参与匹配）。 | 同上 |
| `dsh.manifestVersion` | 可选 | 当前为 `1`。 | `dsh-package-manifest` |
| `dsh.bundle.patch` | bundle 必需 | 一个 patch 文件路径，或按顺序应用的数组，相对包根。 | `dsh-app-boot` §Profiles；`dsh-web-app/package.json` 的 `dsh.bundle.patch` 是数组示例 |
| `dsh.client.platform` | 有浏览器半时必需 | Web 端只认 `"web"`。 | `dsh-package-manifest` 类型注释 |
| `dsh.client.inject` | 可选 | **不是 Cordis 服务注入**，而是「客户端包名依赖」：写进 boot graph 的 `inject` 数组，用于让 provider 先于 consumer 加载。 | `dsh-package-manifest` 类型注释 + 本次实测 boot graph |
| `dsh.client.external` | 可选 | 超出平台基线模块表的**精确** module 请求（可带子路径，如 `<pkg>/client`）。Type-only import 会被擦除、不产生请求。 | 同上；`dsh-client-modules/README.md` §Sharing modules |
| `dsh.client.immediately` | 可选 | 第二阶段一次性注册屏障；一般插件不写。 | 同上 |

**版本范围怎么写才兼容 0.2.1-rc.2（关键坑）**

Node 的 semver 默认**不认 prerelease**，所以 `^0.2.1`、`>=0.2.0`、`0.2.x` 对 `0.2.1-rc.2` 都返回 false，装了也会在启动时被判不兼容。用 semver 7 实测：

```text
>=0.2.1-rc.2 <0.3.0 -> true      ^0.2.1-rc.2 -> true      ~0.2.1-rc.2 -> true
0.2.1-rc.2          -> true      ^0.2.1      -> false     >=0.2.0     -> false   0.2.x -> false
```

推荐写法（按场景二选一）：

```jsonc
// 发布/长期：0.2.x 的后续补丁与正式版继续兼容；0.3 起需要重新验证
"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }

// 只在当前 Harness 上开发验证：最严格
"engines": { "dsh": "0.2.1-rc.2" }
```

注意 `>=0.2.1-rc.2 <0.3.0` 仍会拒绝未来 `0.2.9-rc.1` 这类「不同 patch 元组的 prerelease」（semver 规则），真出现时再放宽。

另外两个**实测**到的约束：

- profile 的 `pnpm-workspace.yaml` 写着 `autoInstallPeers: false`，所以 `peerDependencies` 不会自动装；peer 只起声明/文档作用，真正能用是因为 launcher 的 runtime resolution（见 §1.5）。
- `pnpm add` 会报 peer 警告（“Issues with peer dependencies found”），不影响安装。

### 1.2 cordis.patch.yml 格式

官方 bundle 的 patch 都很短，本质是 Cordis Loader 的 patch 数组。最小可用：

```yaml
# docs/example-plugin/cordis.patch.yml
- insert:
    - id: dsh-va-studio-example        # Loader 行 id：profile/patch 层按它定位、Plugins 页按它显示
      name: dsh-va-studio-example      # 包名；也可写绝对路径 / file URL（临时调试用）
      config:                          # 交给插件 Config schema 校验后的对象
        greeting: hello-from-dsh-va-studio-example
```

语法要点（来源：`dsh-app-boot/README.md` §Profiles、asar 内各 bundle 的 patch）：

- 顶层是 YAML 数组；条目类型有：`insert`（新增行）、按 `id` 覆盖（只写要覆盖的 `config`，**整个 config 会替换而不是深合并**）、`disabled`、`!!js` 表达式。
- `name` 可以是包名、绝对路径、`file:` URL；patch 加载时会把 `insert` 里的绝对路径/`./`、`../` 相对路径转成 file URL（本次实测：绝对路径被打印成 `file:///...`）。
- `config` 里的 `!!js` 可在 boot 时求值，例如官方 base patch 用 `disabled: !!js "!ctx.get('profileContext')"`。
- 空文件/只有注释会让 boot 失败；要禁用这一层写 `[]`。
- 一个 bundle 的 patch 层在 profile 的 `dsh.profile.bundles` 顺序里被应用，**之后**才是 profile 自己的 `cordis.patch.yml` 和 home 级 patch；所以用户可以在 profile patch 里按 `id` 关掉/改你的行。
- 插件行是否 `disabled` 与「bundle 是否被选中」是两件事：Plugins 页关行只写 `disabled` 到最后匹配的 profile override；关 bundle 则改 `dsh.profile.bundles`。

### 1.3 bundle 与 profile 的关系

- profile 目录：`~/.dsh/profiles/desktop/`，关键文件：
  - `package.json`：`dependencies`（外部插件包）+ `dsh.profile.bundles`（有序 bundle 层）。
  - `cordis.patch.yml`：用户自己的覆盖层。
  - `cordis.yml`：空数组的根，注释明确说「改 `cordis.patch.yml`，不要改这里」。
  - `pnpm-workspace.yaml`：`packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false`。
- 安装外部插件 = pnpm 装进 `~/.dsh/profiles/desktop/node_modules`，并把包名追加到 `dsh.profile.bundles`（plugin-manager README：“Installation enables a new bundle by default”；**本次用 CLI 在临时 profile 实测**：bundles 末尾被追加。UI 的 Enable now 按钮见 §4.3）。
- 安装来源在 profile `package.json` 里被记为 `file:<绝对路径>`/`link:`/registry 版本；Plugins 页的 Source 一行就是它。

### 1.4 建议目录布局

```text
dsh-va-studio/
├─ package.json
├─ cordis.patch.yml
├─ dsh/index.js            # Host 半入口（main / exports["."]）
├─ client.js               # 浏览器半（exports["./client"]，单文件可手写）
├─ skills/<skill>/SKILL.md # 随包分发的技能（可选）
├─ locale/                 # 可选：仅当 Host 半用 ctx.locale / 包展示元数据
└─ README.md
```

本仓库已按此布局放了可打包示例：`docs/example-plugin/`（`dsh/index.js` + `client.js` + `skills/va-studio-example/SKILL.md`）。

### 1.5 模块解析（决定了「依赖怎么声明」）

**【读码】** `dsh-app-boot/README.md` §Understand the implementation：

- launcher 在挂载 profile 行之前计算一份不可变 runtime resolution（安装 → 有序 bundle 依赖图的 BFS），装到 Node 的 ESM/CJS resolver 上，**不创建 fallback 链接**。
- 因此插件里 `import '@deepseek-ai/dsh-tools'`、`import '@deepseek-ai/schemastery'` 等不需要写进 `dependencies`，会解析到当前安装里的那一份。
- 反过来，**没有安装进 profile、只是用绝对路径 insert 的插件享受不到映射**：本次实测绝对路径加载示例插件时报
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery' imported from .../docs/example-plugin/dsh/index.js`。
  装进临时 profile 后同一份代码正常加载（见 §5）。

实践结论：**第三方 npm 依赖**（sharp、undici 等）写进 `dependencies` 由 pnpm 装；**Harness 自身包**不要写 dependency，交给 runtime resolution，最多写 `peerDependencies` 作文档。

---

## 2. 服务端（Host）插件 API

### 2.1 插件入口契约

```js
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'        // 与包名一致最省心
export const inject = ['tools', 'systemPrompt'] // 必需服务；缺失时该行保持等待，不会让 app 崩
export const Config = Schema.object({/* ... */})
export function apply(ctx, config) {/* 注册工具/路由/技能/提示分节 */}
```

- `inject` 是 Cordis 服务依赖。**必需服务**写这里，插件会等；**可选服务**用 `ctx.inject(['connection'], ctx => {...})` 懒挂载，避免非 Web 组合下整行卡住。
- `Config` 是 schemastery schema，patch/Plugins 页写入的 `config` 先过它；schema 校验失败时该行不加载（启动时只警告，不影响其他插件）。
- 生命周期：`ctx.effect(fn, label)` 注册的副作用在该 fiber 卸载时自动释放；`ctx.tools.register(...)`、`ctx.connection.fetch.register(...)` 等返回 disposer，直接调用也可以，但推荐包在 `ctx.effect` 里（示例插件对路由和技能都这么做）。
- 日志：`ctx.logger.info('fmt %s', value)`（printf 风格，image-generation 即如此用）。

### 2.2 `defineTool`：工具定义

来源：asar `dsh-tools/README.md` §Register a tool、`dsh-tools/lib/index.js:838-880`（`defineTool` 实参校验与实现）；类型细节来自本地 checkout `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts`（**注意**：asar 内没有 `.d.ts`，checkout 是 0.2.0-rc.2；字段语义已对照 asar 0.2.1-rc.2 实现，见标注）。

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | 是 | 模型可见工具名，全局唯一；重名会让注册失败。 |
| `description` | 是 | 模型路由依据，写清「什么时候调用/不调用」。 |
| `parameters` | 是 | 参数 DSL 的 map（隐式 object 根，默认开放）。每个属性是 `type/description/enum/const/default/examples/items/oneOf` 加 `required: true`。支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、`json`、`oneOf`（**一个节点只能有一个 `type`**；可空值用 `oneOf:[{type:'string'},{type:'null'}]`）。 |
| `output.schema` | 是 | 对 `execute` 返回的规范值（canonical JSON）做强制校验。object 节点**必须显式写 `additionalProperties`**。 |
| `output.render(args, value)` | 是 | 把规范值投影成模型可见的 `ContentBlock[]`；通常 `[{type:'text', text: ...}]`。 |
| `output.presentationMeta(args, value)` | 否 | 可重放的展示元数据（写进 `tool/result` 供 UI 读取）；不是模型内容。 |
| `timeoutMs` | 否 | 正数毫秒；**只是声明**，真正执行由 `@deepseek-ai/dsh-tool-call-timeout-policy` 这个 `tools/execute` wrapper 负责，声明它意味着你会转发/观察 `exec.signal`。 |
| `isConcurrencySafe(args)` | 否 | 返回 `true` 才允许与兄弟调用并行；省略即串行。 |
| `presentCall(args)` | 否 | 纯函数，返回 `{card:'generic', title, kind?, rawInput?, content?, locations?}`（`kind` ∈ `read/edit/delete/move/search/execute/fetch/other`）或 `terminal`/`diff` 卡片；Web Client 主要按 call 参数自行渲染，这个值是 Host 侧展示描述符。 |
| `presentResult(args, result)` | 否 | 同上，返回 `ToolResultView`。 |
| `projectContent(exec, result)` / `finalizeContent(exec, result)` | 否 | 结果内容的前置投影 / 最后一公里变换；一般插件不需要。 |
| `execute(args, exec)` | 是 | 返回**只含** `output.schema` 声明的规范值；错误直接 throw（会变成模型可见的 `Error: ...`，不会终止 turn）。 |

`exec`（`ToolRunContext`）上有什么（`dsh-tools/lib/types/index.d.ts`）：

| 成员 | 含义 |
|---|---|
| `exec.signal` | caller 拥有的取消信号，**必须**观察；长任务要转发给下游。 |
| `exec.arguments` | 经过 JSON 规范化并冻结的模型参数（`args` 是强类型同一份）。 |
| `exec.callId` / `exec.rootCallId` / `exec.token` | 调用身份与关联 token；`parent` 表示是否 PTC 子调用。 |
| `exec.agent` | 当前 Agent；`exec.agent.session.header.cwd` 是会话工作区（示例、image-generation 都这么取）。 |
| `exec.deferContext(userMessage)` | 把一条上下文延迟到本次工具结果之后进入会话（复合工具/子代理用）。 |
| `exec.concludeTurn()` | 标记本次工具结果结束当前 turn（谨慎使用）。 |

可直接抄的最小工具（完整版见 `docs/example-plugin/dsh/index.js`）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

const tool = defineTool({
  name: 'va_studio_status',
  description: 'Return the plugin status. Read-only.',
  parameters: { verbose: { type: 'boolean', description: 'Include the workspace path.' } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        plugin: { type: 'string', required: true },
        workspace: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  timeoutMs: 5_000,
  isConcurrencySafe: () => true,
  presentCall: args => ({ card: 'generic', kind: 'read', title: 'Read plugin status', rawInput: args }),
  async execute(args, exec) {
    exec.signal?.throwIfAborted()
    return { ok: true, plugin: 'va-studio', workspace: exec.agent?.session?.header?.cwd ?? null }
  },
})
ctx.tools.register(tool)   // 注册即可见，schema 由系统提示装配自动带上
```

**返回值如何进入对话**：`render` 返回的 `ContentBlock[]` 就是模型/会话看到的内容（`tool/result` 事件里持久化的是它，`execute` 返回的规范值只对程序化调用方可见）。文本最通用；图片需要附件引用：

```js
// execute 里：需要 ctx.attachments（@deepseek-ai/dsh-attachment 的 AttachmentStore，base 组合默认有）
const ref = await ctx.attachments.saveImage({ data: pngBytes, mediaType: 'image/png', name: 'result.png' })
// ImageAttachmentRef 是「可序列化的持久引用」（attachmentId/mediaType/bytes/width/height），
// 所以可以放进规范值；output.schema 里用 `image: { type: 'json' }` 之类承接。
return { image: ref, sha256, workspace_path: '...' }
```

```js
render: (_args, value) => [
  { type: 'text', text: JSON.stringify({ sha256: value.sha256, path: value.workspace_path }) },
  { type: 'image', attachment: value.image },   // ImageBlock
]
```

注意：`ImageBlock` 需要 `attachment: ImageAttachmentRef`（不是 base64，也不能临时在 `render` 里 await）。是否让模型「看见」图片取决于模型路由能力；官方 image-generation 的选择是**工具只返回文本资产信息，另注册一个鉴权预览端点给 UI 预览**（其 README：“图片以文本资产信息返回给聊天模型，界面预览与模型视觉能力分别处理”）。示例插件只返回文本。

**工具可见性**：registry 在 host 平面，注册后所有 Agent 默认继承；preset 可以 `ctx.tools.restrict({allow, deny})` 收紧全局工具（scoped 注册不受影响）。**【读码】** `dsh-tools/lib/types/index.d.ts:636-644`；本机 preset（`dsh-web-app/presets/*.patch.yml`）没有调用 `restrict`，所以第三方工具默认可见。**【推断】**（未在真实会话验证）。

### 2.3 `ctx.tools` 其余接口

| API | 用途 | 来源 |
|---|---|---|
| `ctx.tools.register(definition)` | 注册工具，返回 disposer。 | `dsh-tools/lib/types/index.d.ts:636` |
| `ctx.tools.restrict({allow?, deny?})` | 对当前 Agent scope 收紧全局工具；返回解除函数。 | 同上 644 |
| `ctx.tools.get(name, scope?)` / `ctx.tools.schemas(scope?)` | 按 scope 解析工具 / 拿可见 schema（不含 execute）。 | `dsh-tools/README.md` §Restrict tools per agent |
| `ctx.tools.guard(guard)` | 在 `tools/pre-execute` 之后加单调 guard，返回理由即拒绝。 | 同上 |

### 2.4 `ctx.connection.fetch.register`：给浏览器调的自注册 HTTP 端点

用途：浏览器半不在 Node 进程里，要读 Host 数据/触发 Host 动作时，注册一个挂在共享 `/api` 通道上的精确路由。**【读码】** `dsh-client-connection` README §Use this package；实现 `lib/index.js:926-977`（`endpointFromPath` / `assertFetchRoute` / `registerFetchRoute`）。

```js
ctx.inject(['connection'], connCtx => {
  connCtx.effect(
    () => connCtx.connection.fetch.register({
      path: '/api/va-studio-example.status', // 必须是 /api/ 下的有效段；不能有空段、. / ..
      methods: ['GET'],                      // 'GET' | 'HEAD' | 'POST'，不能重复、不能为空
      requestBody: 'buffered',               // 'buffered'（默认 JSON 上限）或 'streaming'（背压、无聚合上限）
      fetch: async request => Response.json(
        { ok: true, query: new URL(request.url).search.slice(1) },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    }),
    'my-plugin: status route',
  )
})
```

要点：

- `path` 是**完整路径**（含 `/api`），必须 `startsWith('/api/')`；同名路由重复注册会抛错（`exact Fetch route "..." is already registered`）。
- `fetch(request)` 拿到标准 `Request`，返回标准 `Response`；鉴权/信任由 Connection 在进入 handler 之前完成。
- 只有 owner Peer 能访问该精确路由（非 owner 返回 403），所以浏览器半直接 `fetch('/api/...', { credentials: 'same-origin' })` 即可。
- 返回 `Response.json` 最省事；二进制/大文件用 `streaming`。
- 注册/dispose 走 `ctx.effect`，插件卸载时路由自动移除。

### 2.5 `ctx.credentials`

来源：asar `dsh-credentials/README.md`（全部是可直接抄的签名）。

```js
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'

// 1) 键值型（走环境变量/托管 .credentials.yaml）
const ref = credentialRef('MY_PLUGIN_API_KEY')     // POSIX 标识符
const hit = await ctx.credentials.resolve(ref)      // { value, source } | undefined
const info = await ctx.credentials.describe(ref)    // { configured, source?, writable } —— 永远不含 value
await ctx.credentials.set(ref, 'sk-…')              // 存的值优先于环境变量
await ctx.credentials.unset(ref)

// 2) 记录型（插件自己的结构化凭据，推荐）
const key = credentialKey('my-plugin', 'configuration')  // <owner>/<id>
const record = await ctx.credentials.readRecord(key)     // { kind, payload } | undefined
await ctx.credentials.describeRecord(key)                // { configured, kind?, writable }
await ctx.credentials.listRecords()                      // [{ key, kind }]
await ctx.credentials.modifyRecord(key, async current => ({ kind: 'grant', payload: { ... } }))
await ctx.credentials.deleteRecord(key)
```

规则（README）：`modifyRecord` 是唯一写路径，回调拿到「独占写入时」的记录，返回 `undefined` 表示不改；空值不能存（空字符串算未配置）；记录可持久保存，重启后仍在。**不要把 Key 放进 `config`/patch/日志**；UI 只显示 configured/writable。

### 2.6 `ctx.skills.registerProvider` 与 skills 目录约定

**与 0.2.1 一致吗**：一致。image-generation（0.2.1-rc.2 同版本仓库）的 `index.js` 就是用 `ctx.skills.registerProvider(() => ({...}))`；asar 里 `dsh-skill` 的 `registerProvider(create: (control) => SkillProvider)` 签名相同。**【读码】**

```js
import { readFile } from 'node:fs/promises'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'

ctx.inject(['skills'], skillCtx => {
  const locator = new URL('../skills/my-skill/SKILL.md', import.meta.url)
  const candidate = {
    name: 'my-skill',                                   // kebab-case，全库唯一
    description: '...',                                 // 路由文案
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'my-plugin',
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,                           // 600
    locator,                                            // 不透明句柄，原样传回 get()
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/my-skill/', import.meta.url)) },
  }
  skillCtx.effect(() => skillCtx.skills.registerProvider(() => ({
    name: 'my-plugin',
    list: async () => [candidate],
    get: async selected => selected.name === candidate.name
      ? { ...candidate, content: stripFrontmatter(await readFile(locator, 'utf8')) }
      : undefined,
  })), 'my-plugin: skill provider')
})
```

目录约定（`dsh-skill-filesystem/README.md`）：

- 本地 provider 扫描 `<name>/SKILL.md` 或顶层 `<name>.md`，**不递归**；frontmatter 必须有 `name`（kebab-case）与 `description`，可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`（严格布尔拼写）。
- 扫描根优先级：项目 `.dsh/skills`(100) → `.agents/skills`(200) → `customSkillDirs`(300) → `~/.dsh/skills`(400) → `~/.agents/skills`(500) → 打包内置(600)。
- 注意本机 composition：`dsh-web-app` 把 host 平面的 `skill-filesystem` 关掉了，改为每个 preset 各自挂 `skill-filesystem`；`dsh-skill` **registry 在 host 平面**，host 平面注册的 provider 会进入所有 agent 的合并目录。**【读码】** `dsh-web-app/cordis.patch.yml:507-517`。
- `get()` 返回的 `content` 是**去掉 frontmatter 的正文**（官方 image-generation 用正则剥掉），`invocation`/`provider` 等摘要字段沿用 candidate。

### 2.7 `ctx.systemPrompt.section` 与 `system-prompt/assemble`

最小用法：

```js
ctx.systemPrompt.section({
  name: 'tool:va-studio-example',
  order: 150,                 // 升序拼接；同序按 name 的 code unit 排序；外部插件可用任意有限值
  text: 'When asked whether the plugin is loaded, call va_studio_status.',
  // interpolate: false,      // 需要保留字面 {{...}} 时设置
})
```

按会话动态改写（waterfall 事件，签名与 image-generation 相同）：

```js
ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const configured = await isConfigured()          // 你自己的判断
  const result = await next()                      // 让其他监听者先跑
  return {
    ...result,
    sections: result.sections.map(section => section.name === 'tool:va-studio-example'
      ? { ...section, text: configured ? CONFIGURED_TEXT : UNCONFIGURED_TEXT }
      : section),
  }
})
```

规则（`dsh-system-prompt/README.md`）：一个 `complete: true` 的 section 会变成完整提示（多于一个会让装配失败）；变量用 `{{name}}`，未注册/无值会**抛错并阻止请求**；工具 schema 由工具 registry 自动进入装配，不需要手写。另可用 `ctx.systemPrompt.variable(name, () => value)` 注册变量。`order` 常量可优先用 `ctx.systemPrompt.getSectionOrder(name)`（仓库内部约定），外部插件用任意有限值即可。

### 2.8 可选/暂不深入

| 能力 | 入口 | 备注 |
|---|---|---|
| 斜杠命令 | `ctx.commands.register(...)`（`@deepseek-ai/dsh-commands`） | 官方 `command-goal` 等在用；本次未展开，读 asar `dsh-commands/README.md`。**【未验证】** |
| 附件 | `ctx.attachments.saveImage/saveFile/admitPromptContent/readImage` | 见 §2.2 图片段；完整签名 `dsh-attachment/lib/types/index.d.ts`。 |
| 会话/设置 | `ctx.settings`、`ctx.sessionController`、`ctx.sandboxPolicy` | image-generation 用到 `sessionController`/`sandboxPolicy`；按需注入。 |
| 工作区 | `exec.agent.session.header.cwd` + `ctx.sandboxPolicy.resolve({session})` | 想写文件前先校验 policy（image-generation `lib/assets.js`）。 |

---

## 3. 客户端（浏览器）插件

### 3.1 手写单文件 `client.js` 可行吗？

**可行，官方 image-generation 就是这么做的**：package.json 里 `exports["./client"]: "./client.js"`、`dsh.client.platform: "web"`，文件内容只有 `window.__ModuleLoader__.load({ id, factory(require) {...} })`。**不需要构建工具**，但：

- 不能写 JSX（`factory` 是普通函数，需要 `React.createElement`），也不能用 ESM `import/export`。**【读码】** 本地 checkout `packages/AGENTS.md`：「现有 `client.js` 使用 `window.__ModuleLoader__.load`…未建立编译与打包链路前不能直接改成 TS/TSX」。
- `id` 用包名；`factory(require)` 返回 `{ inject: [...], apply(ctx) {...} }`。
- 顶层只做注册，副作用放 `factory` 内（宿主注释：“running a bundle only registers a factory; module side effects run at materialization”，`dsh-client-modules/README.md`）。

最小骨架（完整版见 `docs/example-plugin/client.js`）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-va-studio',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'locale'],   // Cordis 客户端服务
      apply(ctx) { /* 注册页签、locale、CSS、fetch */ },
    }
  },
})
```

### 3.2 `require` 基线里有哪些模块

**实测**：从本机 asar 内前端 bundle（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`）搜到平台静态表：

```js
function SZ() {
  return {
    react, 'react/jsx-runtime': ..., 'react-dom': ..., 'react-dom/client': ...,
    '@deepseek-ai/cordis': ...,
    zod: ...,
    '@tanstack/react-virtual': ...,
    '@deepseek-ai/dsh-client-store': ...,
    '@deepseek-ai/dsh-client-ui-slots': ...,
    '@deepseek-ai/dsh-client-ui-primitives': ...,
    '@deepseek-ai/dsh-client-ui-dockkit': ...,
  }
}
```

| 基线模块 | 说明 |
|---|---|
| `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client` | 直接用 |
| `@deepseek-ai/cordis` | 客户端 Cordis |
| `@deepseek-ai/dsh-client-store` | 客户端 store |
| `@deepseek-ai/dsh-client-ui-slots` | slot 核心（`register`/`inject` 的引擎） |
| `@deepseek-ai/dsh-client-ui-primitives` | 共享 UI 原语（Menu、Icon 等） |
| `@deepseek-ai/dsh-client-ui-dockkit` | dock 组件 |
| `zod`、`@tanstack/react-virtual` | 工具库 |

- 这 11 个之外的名字**不能**直接 require；要额外模块：在 `dsh.client.external` 写**精确**请求（如 `"my-other-plugin/client"`），且该请求必须由某个 active 插件行或静态表键提供，否则组合阶段就报错（`dsh-client-modules/README.md` §Sharing modules）。
- 自查方法：`cat`/`grep` 上面那个前端 bundle；或看 boot graph（`window.__DSH_BOOT__.entries[].external`）。**【实测】**：本次示例插件的 boot graph 条目为
  `{"id":"dsh-va-studio-example","url":"plugins/??dsh-va-studio-example/client.js&rev=…","rev":"…","inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings-plugins"]}` —— `inject` 就是 `dsh.client.inject`，用于加载顺序。

### 3.3 注册设置页签：`settings.plugins.tab`

容器由 `@deepseek-ai/dsh-client-ui-settings-plugins` 声明（Settings → 内置插件 / Built-in plugins）。它的 `apply` 源码（asar `dsh-client-ui-settings-plugins/lib/client.js`）是权威模板：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'plugins', order: 15, locale: NS,
  label: () => t('nav'),
  children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
}, PluginsSettingsSection))
```

贡献页签（本次示例已跑通离线校验）：

```js
ctx.slots.inject('settings.plugins.tab', () =>
  ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'va-studio',            // list slot 必填：决定“一格”
    order: 100,                 // 页签顺序
    locale: NS,                 // 声明后组件 props 里自动有 t
    label: () => t('title'),    // 页签文案（locale 感知）
    // inject: () => ({ callApi }),  // 需要给组件注入业务 props 时用
  }, VaStudioCard),
)
```

- 组件签名（框架注入的 props）：`{ t, ...inject() 的返回值 }`，另有 `renderSlot`/`renderFactorySlot`/store 等 share；**只有 `locale` 声明时才自动给 `t`**。**【读码】** `dsh-client-ui-slots/lib/types/index.d.ts`（`BaseOptions`）+ settings-plugins 源码。
- 用 `ctx.slots.inject(key, cb)` 而不是直接 `register`：容器插件的加载顺序不确定，`inject` 会在声明出现时执行、声明消失时释放。**【读码】** `dsh-client-ui-renderer/lib/types/client/registry.d.ts:100-118`。
- slot 是 `list`，同一 `id` 只有一个赢家；多个插件可各占一格。
- 只做设置页**不需要** `uiConversation`。`uiConversation` 只在要往对话流里插节点/事件映射时需要（image-generation 用它渲染生成图），示例插件只 `inject: ['slots','locale']`。

**更“官方”的第三方入口（建议同时了解）**：第三方 bundle 自己的配置页更推荐注册到 Plugins 页的 slot（`dsh-client-ui-plugin-manager/README.md` §Configuration pages）：

| slot | kind | key / 必填 | 用途 |
|---|---|---|---|
| `plugins.item` | list | `id` | 官方内置插件的配置卡（Built-in plugin settings 列表） |
| `plugins.bundle.config` | keyed | `key = 包名` | 整个 bundle 的配置，显示在 bundle 详情页 |
| `plugins.row.config` | keyed | `key = "<包名>#<行 id>"` | 某一行自己的配置页（推荐给第三方 bundle） |

例：

```js
ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
  name: 'plugins.row.config',
  key: 'dsh-va-studio#va-studio',   // 必须和 cordis.patch.yml 的 insert.id 对应
  locale: NS,
}, ({ t, view }) => view === 'summary' ? t('summary') : h(VaStudioForm, { t })))
```

### 3.4 locale、CSS、fetch

```js
const NS = 'vaStudio'

apply(ctx) {
  // 1) 字典：zh + en 必须成对
  ctx.effect(() => ctx.locale.register(NS, {
    zh: { title: 'VA Studio', save: '保存' },
    en: { title: 'VA Studio', save: 'Save' },
  }), 'va-studio: locale')
  const t = ctx.locale.bind(NS)

  // 2) CSS：幂等 guard + 卸载时移除；选择器加插件前缀，只用 --dsw-alias-* 主题变量
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = 'dsh-va-studio'
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, 'va-studio: styles')

  // 3) 调 Host 自注册端点（同源 cookie 鉴权）
  const res = await fetch('/api/va-studio.status', { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
  const data = await res.json()
}
```

- `ctx.locale.register(ns, { zh, en })`：字典按语言分表，`bind(ns)` 返回 `t(key)`；`ctx.locale.resolveText(localizedText)` 可解析包展示用的 `LocalizedText`。**【读码】** `dsh-client-locale/README.md` §Registering a dictionary。
- CSS 用 `data-plugin-css` 做幂等 guard、插件前缀限定选择器、只使用 `--dsw-alias-*` 语义变量（本地 checkout `packages/AGENTS.md` 的硬性约束）。**【读码】**
- 网络请求集中在一个函数里（loading/error/cancel），不要散落在展示组件；`AbortController` + 卸载时 abort。

### 3.5 客户端加载链路（帮助理解“为什么改了没生效”）

**【读码】** `dsh-client-modules/README.md`：

- Host 半扫描已启用 Loader 行里声明了 `dsh.client` 的包 → 解析 `exports["./client"]` → 把源码快照进 boot graph（`window.__DSH_BOOT__`）。
- 页面通过 combo URL `/plugins/??<id>/client.js&rev=<mtime>` 批量拉取；执行只注册工厂，真正 materialize 才跑副作用。
- 修订号来自 mtime/ctime/size，不哈希内容；**改完要重启 Host 或让 HMR 重新快照**。
- 页面与 Host release（version+commit）不一致时页面不会应用新图，必须刷新页面。
- 动态启用/禁用插件会通过 HMR 图增量更新；未启用插件不会出现在 boot graph。

---

## 4. 安装与加载

### 4.1 本机可用的 `dsh` CLI

**实测**：`which dsh` 为空（不在 PATH）。可用的唯一入口是应用自带 shim：

```
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
```

下文命令里的 `dsh` 都代指这个完整路径（建议在自己 shell 里 `alias dsh='.../runtime/cli/bin/dsh'`，不要改用户 profile 之外的系统文件）。

它做的事（`runtime/cli/bin/dsh` 源码 + asar `dsh-desktop-host/lib/cli.js`）：

1. 递归解析 symlink，算出 `Resources` 目录；
2. `ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"`；
3. `cli.js` 调 `runCli({ manageDesktopProfile: true, packageManager: { command: process.execPath, args: [..., pnpm/bin/pnpm.mjs], env: { ELECTRON_RUN_AS_NODE: "1", ... } } })`。

这就是 README 里说的 **bundled command runtime**：用应用自带的 Electron(Node 模式) + 自带 pnpm（`runtime/primary-runtime/dependencies/pnpm`，版本 **11.28.5**）管理 Electron 独占的 `desktop` profile。

**实测**：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" --version            # 0.2.1-rc.2
"$DSH" --help               # 启动器帮助（profile/boot/dump/plugin）
"$DSH" plugin --help        # 插件子命令帮助
"$DSH" plugin --profile desktop --version   # 11.28.5（证明已转发到自带 pnpm）
```

**不要**用系统 `node`（v22.13）去跑 asar 里的 `bin.js`：Electron 应用树依赖 asar 虚拟文件系统、Node 内部模块与 native addon，官方 shim 已处理这些。**【推断】**（未实测失败路径，但 shim 是唯一受支持入口）。

### 4.2 `dsh plugin` 语法

```bash
dsh plugin --profile <name> <pnpm 参数...>       # 参数原样转发给 pnpm（在 profile 目录执行）
```

常用：

```bash
"$DSH" plugin --profile desktop add <包名>@<版本>
"$DSH" plugin --profile desktop add /绝对路径/插件目录
"$DSH" plugin --profile desktop add /绝对路径/插件.tgz
"$DSH" plugin --profile desktop remove <包名>
"$DSH" plugin --profile desktop why <包名>
"$DSH" plugin --profile desktop version-exemptions
"$DSH" plugin --profile desktop allow-version <pkg>@<ver> --dsh-version 0.2.1-rc.2 --accept-risk
"$DSH" plugin --profile desktop revoke-version <pkg>@<ver> --dsh-version 0.2.1-rc.2
```

要点（`dsh/lib/plugin-BiveYA7h.js` + `dsh-plugin-manager/README.md`）：

- **本地目录与 `.tgz` 都支持**；`parseInstallSpec` 要求本地路径**必须绝对**（`file:`/`link:` 前缀可写，相对路径会被拒绝）。**【读码】+【实测】**（`.tgz` 安装实测成功；目录形式由同一 path 分支 + pnpm `file:`/`link:` 语义支持，**未实测**）。
- `add` 会做**兼容性预检**：读本地 package.json / registry 版本，检查 `engines.dsh` 或 DSH peer range，不通过就拒绝且什么都不装；拒绝信息里给出 `allow-version` 命令。**【读码】**
- 安装成功后会 `reconcile(...)`：**把新 bundle 追加到 `dsh.profile.bundles`（自动启用）**。**【实测】**（临时 profile 的 bundles 末尾出现 `dsh-va-studio-example`）。
- `desktop` 是 Electron 独占 profile：对 `desktop` 的 **boot 与 `--dump-config`/`--dump-config-schema` 会被拒绝**，但**插件管理允许**（前提是 profile 已由应用初始化过）。**【实测】**：
  - `dsh --profile desktop --dump-config` → `error: profile "desktop" is managed exclusively by the Electron application`
  - `dsh plugin --profile desktop --version` → `11.28.5`
- `desktop` 走 `runProfilePnpm`（而不是服务路径的 `runPluginCommand`）：它会快照 `package.json`/`pnpm-lock.yaml`，失败时回滚；成功时也可能因 pnpm 重算 lockfile 而增删 `node_modules` 里的包（临时 profile 实测出现 `Packages: +1 -12` 的裁剪提示）。**因此改真实 profile 前先备份。**

### 4.3 Web GUI 的 Plugins 页：Add plugin

来源：asar `dsh-client-ui-plugin-manager/README.md` §Installing a bundle。

- 侧边栏 **Plugins** 页 → **Add plugin**（主按钮）/ 箭头菜单 → **Install a third-party plugin**。
- 输入框**接受**：包名（可带 `@版本`）、Git 地址（`github:`/`git+…`/仓库 URL）、**tarball**（本地绝对路径或 http(s) 链接）、**绝对本地目录**。相对路径会被拒绝。
- 流程：`pluginManager.inspect(spec)` 先读目标（registry 用 `pnpm view`；绝对路径直接读其 `package.json`）→ 通过后 `installBundle`（pnpm 运行、实时日志、可取消）→ 完成页 **Enable now** 或关闭。README 同时写着 “Installation enables a new bundle by default”，CLI 路径实测会自动追加 bundles；**UI 是否在点 Enable now 之前就已启用未验证**，以安装后 Plugins 卡片 / `package.json` 为准。
- 安装失败会恢复 `package.json` 与 `pnpm-lock.yaml`；下载内容可能残留。
- pnpm 11 拦构建脚本时，失败页出现 **Allow these scripts and retry**（同意记录写进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`）。
- 安装成功**不代表**模块一定能激活；激活失败会在卡片上显示错误（“A successful installation does not certify that a module can activate”）。

**与 CLI 的区别**：Plugins 页走 Host 服务（有进度、可取消、自动回滚、自动启用、错误码本地化）；CLI 走 `runProfilePnpm`（同样预检+自动启用，但无 UI 进度）。应用运行时优先用 Plugins 页，能避免与应用写 profile 的并发冲突。

### 4.4 安装后要不要重启 Harness？

plugin-manager README 的原文说法是：「With HMR enabled in YAML, configuration changes apply immediately; without HMR, the running composition remains until restart.」而 `dsh-hmr/README.md` 补充：「Profile recompositions run by HMR's profile watches and by Plugin Manager also replace plugins whose loaded files below the profile directory changed on disk.」

**结论分三层，务必按层理解：**

1. **配置层（一定热生效）**：base bundle 在存在 `profileContext` 时启用 `dsh-hmr`，`root: []` 表示只监听配置文件（profile manifest + profile/home patch）。安装/启用改的正是这些文件，所以会触发一次 recomposition。**【读码】** `dsh-base/cordis.patch.yml:28-32`、`dsh-hmr/README.md`。
2. **模块层（本机大概率可热加载，但未端到端验证）**：完整模块热替换需要 Node 内部 loader；Host 进程由 Electron 以 `--expose-internals` 启动（`lib/main.js:3794-3798`）。**实测**用应用二进制以 Node 模式运行：
   `ELECTRON_RUN_AS_NODE=1 "…/MacOS/DeepSeek Harness" --expose-internals -e "require('internal/modules/esm/loader')"` → `internals-ok`。
   因此本机 Host 能构造出完整 `dsh-hmr`，`installBundle` 走 `hmr.reconcileProfile()` 后应**无需重启**即可挂载新行、新增 client bundle 并让页面增量更新。
   **【未验证】** 真实应用里第一次安装后是否零重启：取决于 **Desktop shell 的 updater/重启策略**与插件自身加载错误。建议安装后先看 Plugins 卡片状态与 toast：出现 `restart-required`（`restartReason: no-hmr | package-moved`）时再重启。
3. **Desktop 特有坑（本机不一定适用）**：`项目/dsh-desktop` checkout 里有一个 `dsh-desktop-hmr-fallback`（只提供 config watch，不做模块热替换），用于「打包 Electron 拿不到 Node internals」的签名构建。**本机 asar 里没有这个包**（实测 grep 0 命中），所以不要按它推断本机行为；但如果你在其他 Harness 构建上遇到「装了必须重启」，先查这个 fallback 是否在组合里。

### 4.5 验证加载（按成本从低到高）

| 级别 | 做法 | 能证明什么 |
|---|---|---|
| L0 装前 | `dsh --profile <非desktop> --patch <overlay.yml> --dump-config`（overlay 里按绝对路径 insert 插件） | 组合层接受你的 patch 行、`!!js` 求值、行顺序正确 |
| L0+ | `DSH_HOME=/tmp/xxx dsh plugin --profile web add <tgz>` 后再 `--dump-config` | 安装、自动启用、bundle patch 应用（**本次实测**） |
| L1 | 复制一份 desktop profile 到临时 DSH_HOME 的 `desktop-copy`，装插件后 `--dump-config` | **真实 desktop 组合** + 你的 bundle patch（**本次实测**，见 §5.4） |
| L2 | `DSH_HOME=/tmp/xxx dsh --profile web --no-open --port 0`（临时 profile） | Host 半真实激活、`/api` 端点可访问、client bundle 进入 boot graph（**本次实测**） |
| L3 | 真实应用：Plugins 页安装 → 卡片状态/设置页 | 应用内加载、UI 渲染、locale、错误提示 |
| L4 | 新会话里让模型调用工具 | 工具可见性与模型行为 |

**日志/证据位置（本机实测）**

| 位置 | 内容 |
|---|---|
| `~/Library/Logs/DeepSeek Harness/crash-<ISO>-host.log` | 应用启动/运行失败诊断；**列出失败插件名与原因**（本次读到 EADDRINUSE、required 插件未激活等样例）。由 `app.setAppLogsPath()` 决定，Electron 默认目录。 |
| `~/Library/Logs/DeepSeek Harness/crash-<ISO>-web-boot.log` | Web 启动失败 |
| `$DSH_HOME/logs/startup-<ISO>-<uuid>.log` | **CLI** 启动 profile 失败时的完整诊断（`dsh/lib/bin.js` 的 `reportStartupFailure`） |
| `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log` | Plugins 页/CLI 每次 pnpm 运行的完整日志（**实测**目录里已有 operation-*） |
| `~/.dsh/profiles/desktop/{package.json,cordis.patch.yml,pnpm-lock.yaml}` | 安装/启用的落盘结果；`compatibility.json` 存版本豁免 |
| `http://127.0.0.1:<port>/plugins/??…&rev=…`（需登录 cookie） | 实际下发给浏览器的 client bundle（可用 curl + cookie 验证） |

> 本机应用没有长期的 `harness.log`；Host 的 stderr 由 Electron 内存持有，只在 fatal 报告里落盘。看实时诊断可用 Console.app / `log stream --predicate 'process == "DeepSeek Harness"'`。**【未验证】**

**确认工具已注册**：无法从 CLI dump `desktop` 的系统提示（`--dump-config` 被拒）。可行做法：新开一个会话 → 让模型列出可用工具或直接调用你的工具；或在会话里观察系统提示里的工具声明。**【未验证】**（本次只验证到 Host 半激活 + 端点 + client bundle 下发）。

### 4.6 风险与回滚

**安装前建议**

1. 备份：`cp ~/.dsh/profiles/desktop/{package.json,pnpm-lock.yaml,cordis.patch.yml} /tmp/dsh-profile-backup-$(date +%s)/`。
2. 确认没有正在跑的生成/工具任务（Electron 退出时会检查；CLI 改动 profile 与应用写盘可能并发）。
3. 首次验证优先用临时 `DSH_HOME`（`DSH_HOME=/tmp/dsh-scout dsh …`）或 profile 副本，不要直接上真实 profile。

**失败模式与应对**

| 现象 | 含义 | 处理 |
|---|---|---|
| 启动直接失败、弹错误框 | 你的插件是 required 或导致进程级异常（未捕获 Promise/同步回调抛错是 **fatal**，见 `dsh-app-boot` 失败表） | 错误框第三个按钮：**禁用第三方插件、备份 profile patch 并重启**（`DesktopFatalRecovery.disablePlugins → sanitizeProfile`，会把 `cordis.patch.yml` 改名成 `.bak-<时间戳>` 并恢复 bundles） |
| 应用照常启动，但日志有 “N entry did not activate” | 你的行是 optional，失败被隔离 | 看 crash/诊断里的包名与错误；修代码或按 §4.6 手动回滚 |
| Plugins 页卡片报错 / 设置页不出现 | 模块导入/activate 失败，或 client bundle 缺失 | 检查 `exports["./client"]`、`dsh.client.platform`、`inject` 服务是否存在；看 `.plugin-manager/logs` 与浏览器 console |
| 安装被拒（incompatible-version） | `engines.dsh`/peer 不匹配 | 改 range，或 `dsh plugin --profile desktop allow-version <pkg>@<ver> --dsh-version 0.2.1-rc.2 --accept-risk`（写入 `compatibility.json`，仅该精确版本对） |
| pnpm 拦构建脚本 | 原生依赖需要构建授权 | 失败页 **Allow these scripts and retry**；或 `pnpm-workspace.yaml` 的 `allowBuilds` 加精确包名 |

**回滚（任选，从轻到重）**

1. **应用内**：Plugins 页 → 你的 bundle → 开关关闭（只写 `disabled` override，保留依赖）；或 **Remove**（取消选择 + 卸载 + 重装锁文件）。
2. **CLI**（建议先退出应用）：`dsh plugin --profile desktop remove <包名>`；它会改 bundles、跑 pnpm remove，并处理重启提示。
3. **手动**（应用退出后）：
   - 编辑 `~/.dsh/profiles/desktop/package.json`：从 `dsh.profile.bundles` 删掉包名，从 `dependencies` 删掉条目；
   - 删除/还原 `~/.dsh/profiles/desktop/cordis.patch.yml` 里针对你的 `id` 的 override（只含 `id`+`disabled` 的 override 可以被安全删掉）；
   - `pnpm install` 或直接删 `node_modules/<包名>`；
   - 重启应用。
4. **兜底**：把备份的 `package.json`/`pnpm-lock.yaml`/`cordis.patch.yml` 拷回，或使用启动失败对话框的「禁用第三方插件」。
5. 兼容性豁免写入了 `compatibility.json` 的话，用 `revoke-version` 撤销（不会改依赖，但改判定）。

> 说明：bundle 自带的 `cordis.patch.yml` 只存在于**插件包内**，不会写进 profile patch；因此回滚时通常只需把包名移出 bundles，profile 里不会残留你的 insert 行。**【读码】+【实测】**（临时 profile 的 patch 文件保持 `[]`，行来自 bundle 层）。

---

## 5. 最小示例验证（本次实测记录）

示例位置：`docs/example-plugin/`。它实现：1 个只读工具 `va_studio_status`、1 个 `/api/va-studio-example.status` GET 端点、1 个系统提示分节、1 个随包 SKILL.md、1 个 Settings 页签。

### 5.1 打包结果

命令（系统 npm 的 cache 目录有 root 权限问题，指定临时 cache）：

```bash
cd docs/example-plugin
node verify/check-client.mjs                                   # 离线校验 client bundle
npm pack --cache /tmp/npm-cache-scout --pack-destination .      # 产出 tarball
tar -tzf dsh-va-studio-example-0.0.1.tgz
shasum -a 256 dsh-va-studio-example-0.0.1.tgz
```

tarball：`docs/example-plugin/dsh-va-studio-example-0.0.1.tgz`（7,252 bytes，shasum `b4b1a55b5d274df077c22b923054b9279f22cd7171512d654514b3772855818f`）。

`tar -tzf` 结果（完整文件：`docs/example-plugin/verify/tar-tzf.txt`）：

```text
package/client.js
package/dsh/index.js
package/package.json
package/README.md
package/skills/va-studio-example/SKILL.md
package/cordis.patch.yml
```

`npm pack` 摘要（完整文件：`docs/example-plugin/verify/pack.log`）：

```text
npm notice package: dsh-va-studio-example@0.0.1
npm notice Tarball Contents
npm notice 1.5kB README.md
npm notice 7.1kB client.js
npm notice 324B cordis.patch.yml
npm notice 6.6kB dsh/index.js
npm notice 1.1kB package.json
npm notice 625B skills/va-studio-example/SKILL.md
npm notice package size: 7.3 kB
npm notice total files: 6
```

### 5.2 client bundle 离线校验

`docs/example-plugin/verify/check-client.mjs` 模拟 `window.__ModuleLoader__`、`document`、`require` 基线，执行 `factory` 并调用 `apply(ctx)`，断言：bundle id、`inject`、slot 名/id/order/locale/label、locale 字典、CSS 注入、disposer。结果（完整日志 `verify/check-client.log`）：**全部通过**。

### 5.3 组合层验证（未安装）

```bash
# overlay 里按绝对路径 insert
DSH_HOME=/tmp/dsh-scout-home dsh --profile web \
  --patch /tmp/dsh-scout-overlay.yml --dump-config
```

退出码 0、stderr 为空，dump 末尾出现（完整见 `verify/dump-config-evidence.txt`）：

```text
# == /tmp/dsh-scout-overlay.yml
- id: dsh-va-studio-example-scout
  name: file:///Users/mac/Desktop/xxt/dsh-va-studio/docs/example-plugin/dsh/index.js
  config:
    greeting: overlay-config
```

同时实测：**用绝对路径 insert 的插件在真正 import 时会失败**（`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`）——这验证了 §1.5 的「安装进 profile 才有 runtime resolution」。

### 5.4 真实 desktop 组合验证（profile 副本）

```bash
# 1) 复制真实 desktop profile 到临时 DSH_HOME，避免动用户 profile
rsync -a ~/.dsh/profiles/desktop/ /tmp/dsh-scout-home3/profiles/desktop-copy/
# 2) 用自带 CLI 往副本里装 tarball（自动启用 bundle）
DSH_HOME=/tmp/dsh-scout-home3 dsh plugin --profile desktop-copy add \
  /Users/mac/Desktop/xxt/dsh-va-studio/docs/example-plugin/dsh-va-studio-example-0.0.1.tgz
# 3) dump 副本（注意 desktop 名字保留，用 desktop-copy）
DSH_HOME=/tmp/dsh-scout-home3 dsh --profile desktop-copy --dump-config
```

结果：安装把 `dsh-va-studio-example` 追加到副本的 `dsh.profile.bundles`；dump 退出码 0、stderr 为空，真实 desktop 组合（含 `dsh-experimental-*` 等 bundle）中出现（完整见 `verify/dump-config-evidence.txt`）：

```text
# == dsh-va-studio-example
- id: dsh-va-studio-example
  name: dsh-va-studio-example
  config:
    greeting: hello-from-dsh-va-studio-example
```

### 5.5 运行时验证（临时 profile 真启动）

在一个干净的临时 `DSH_HOME` 里安装并**真实启动 web profile**：

```bash
DSH_HOME=/tmp/dsh-scout-home2 dsh plugin --profile web add <tgz>       # 自动启用
DSH_HOME=/tmp/dsh-scout-home2 dsh --profile web --no-open --host 127.0.0.1 --port 0
```

然后取启动日志里的 `?token=` URL，用 cookie jar 请求：

```text
# 启动日志无 “did not activate / failed to import” —— Host 半成功激活
# GET /                             -> 200
# boot graph 条目：
{"id":"dsh-va-studio-example","url":"plugins/??dsh-va-studio-example/client.js&rev=a6ec3803250e","rev":"a6ec3803250e","inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings-plugins"]}
# GET /api/va-studio-example.status?verbose=1 -> HTTP 200
{"ok":true,"plugin":"dsh-va-studio-example","version":"0.0.1","greeting":"hello-from-dsh-va-studio-example","query":"verbose=1","server":"host"}
# GET /plugins/??dsh-va-studio-example/client.js&rev=… -> 200，内容含 settings.plugins.tab
```

完整记录：`docs/example-plugin/verify/runtime-load.log`。

这一次验证覆盖了：安装 → 自动启用 → bundle patch → `engines.dsh` 兼容 → Config 校验（greeting 来自 patch）→ `apply` 内 `ctx.tools.register` / `connection.fetch.register` / systemPrompt / skills provider 全部执行无异常 → client bundle 被宿主组合并下发。

### 5.6 本次**没有**验证的（明确列出，别当成已通过）

| 项 | 为什么 | 下一步 |
|---|---|---|
| 真实 `~/.dsh/profiles/desktop` 上安装 | 任务要求不改用户 profile | 备份后从 Plugins 页安装一次，按 §4.5 L3/L4 验证 |
| 安装后**免重启**热挂载到正在运行的应用 | 需要往真实 profile 装 | 装后在 Plugins 页看是否出现 `restart-required` toast；必要时重启 Harness |
| 设置页签在真实 UI 中的渲染 | 需要重启/加载到真实应用 | 打开 Settings → 内置插件，确认出现 “VA Studio 示例” 页签 |
| 模型侧 `va_studio_status` 可见/可调用 | 需要真实会话与模型 | 新会话问“插件是否加载”，或直接要求调用该工具 |
| `presentCall` 在 Web Client 的具体卡片样式 | Web Client 主要按 call 参数自渲染 | 在会话中调用一次观察 |
| `ctx.commands.register` | 未展开 | 读 asar `dsh-commands/README.md` 后单独验证 |
| 工具返回图片（`ImageBlock`） | 示例未用 | 参考 image-generation 的“文本资产 + fetch 预览端点”模式 |

---

## 6. 本插件（`dsh-va-studio`）实现检查清单

**包与协议**

- [ ] `package.json`：`name`/`version`/`type: module`/`main`/`exports["."]`/`exports["./client"]`/`exports["./package.json"]` 齐全。
- [ ] `engines.dsh` 用 `>=0.2.1-rc.2 <0.3.0` 或精确 `0.2.1-rc.2`；**不要**写 `^0.2.1`/`>=0.2.0`/`0.2.x`。
- [ ] `dsh.bundle.patch` 指向随包 `cordis.patch.yml`；`files` 包含 `dsh/`、`client.js`、`skills/`、patch。
- [ ] 有浏览器半时：`dsh.client.platform: "web"`、`dsh.client.inject` 列客户端依赖包（仅用于顺序）；需要基线外模块时才写 `dsh.client.external`（精确请求）。
- [ ] `cordis.patch.yml` 的 `insert[].name` = 包名；`insert[].id` 与 client `plugins.row.config` 的 `key` 一致。

**Host 半**

- [ ] 具名导出 `name`/`inject`/`Config`/`apply`；必需服务进 `inject`，可选服务用 `ctx.inject` 懒挂。
- [ ] 工具用 `defineTool`：`name` 全局唯一、`description` 写清触发条件、`parameters` 用 DSL（可空用 `oneOf`）、`output.schema` 的 object 显式 `additionalProperties`、`render` 只返回 `ContentBlock[]`。
- [ ] `execute` 观察 `exec.signal`；长任务转发 signal；`timeoutMs` 只在真的能协作取消时声明。
- [ ] 有副作用的注册（tools/fetch route/skills provider/commands）包在 `ctx.effect` 里，确保卸载可逆。
- [ ] 自注册端点路径以 `/api/` 开头、method 唯一、`fetch` 返回 `Response`；不要自己实现鉴权（Connection 已做 owner 校验）。
- [ ] 凭据只走 `ctx.credentials`（`credentialKey('<包名>','<id>')` + `modifyRecord`），绝不进 config/日志/工具入参；UI 只用 describe 的 configured/writable。
- [ ] 技能：`SKILL.md` frontmatter 含 `name`/`description`，`get()` 返回剥掉 frontmatter 的 `content`；name kebab-case 且全库唯一。
- [ ] 系统提示分节用稳定 `name` + 有限 `order`；动态内容走 `system-prompt/assemble` 或 `variable`；不要在文本里留未注册的 `{{...}}`。
- [ ] 不要写 detached 的未捕获异步任务（未处理 rejection 会让整个应用退出，见 app-boot 失败表）。

**Client 半**

- [ ] 单文件 `client.js`，顶层只有 `window.__ModuleLoader__.load({ id: '<包名>', factory })`；无 ESM `import/export`、无 JSX。
- [ ] `factory(require)` 只 require 平台基线 11 个模块中的名字；其余走 `dsh.client.external`。
- [ ] 返回 `{ inject: ['slots','locale'], apply }`；不需要 `uiConversation` 就不声明。
- [ ] 设置页签用 `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({...}))`；第三方 bundle 的配置页优先考虑 `plugins.row.config`（key=`<包名>#<行 id>`）。
- [ ] locale 字典 zh+en 成对注册，`ctx.locale.bind(ns)` 取文案；不在组件里内联整句文案。
- [ ] CSS 用 `data-plugin-css` 幂等注入、插件前缀选择器、只用 `--dsw-alias-*` 变量、可移除。
- [ ] 网络请求集中、带 `AbortController` + 超时 + 错误分类；卸载时 abort/清理；不依赖 `uiConversation`。
- [ ] 组件覆盖 loading/error/empty/disabled、键盘焦点与深浅主题。

**安装与验证**

- [ ] 先在 `DSH_HOME=/tmp/…` 的临时 profile 演练：`plugin add` → `dump-config` → 启动 web profile 验证端点/boot graph。
- [ ] 真实 profile 安装前备份 `package.json`/`pnpm-lock.yaml`/`cordis.patch.yml`；优先用 Plugins 页（有进度、可取消、自动回滚）。
- [ ] 安装后检查：Plugins 页卡片状态、Settings → 内置插件页签、`~/Library/Logs/DeepSeek Harness/crash-*-host.log`、profile `.plugin-manager/logs`。
- [ ] 新会话验证工具可见性（L4）；出现 `restart-required` 再重启 Harness。
- [ ] 准备回滚脚本：从 bundles 移除包名 + `dsh plugin --profile desktop remove` + 恢复备份。
- [ ] 若发布到 registry：`Package@<运行中的 DSH 版本>`（Plugins 页 Update 用），并保持 `engines.dsh` 与当前版本匹配。

---

## 附录 A：来源索引（asar 内路径）

所有路径都在 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内，前缀 `dsh/node_modules/@deepseek-ai/`：

| 主题 | 文件 |
|---|---|
| CLI 入口/参数/日志 | `dsh/lib/bin.js`、`dsh/lib/plugin-BiveYA7h.js`、`dsh-desktop-host/lib/cli.js` |
| profile 组合/兼容性/失败策略 | `dsh-app-boot/README.md`、`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`、`dsh-web-app/presets/*.patch.yml` |
| 插件包元数据 | `dsh-package-manifest/README.md`（类型在本地 checkout 同名包 `lib/types/types.d.ts`） |
| 工具 API | `dsh-tools/README.md`、`dsh-tools/lib/index.js`（类型在本地 checkout `dsh-tools/lib/types/*.d.ts`） |
| Connection 路由 | `dsh-client-connection/README.md`、`dsh-client-connection/lib/index.js`（类型在本地 checkout `lib/types/rpc.d.ts`） |
| 凭据 | `dsh-credentials/README.md` |
| 技能 | `dsh-skill/README.md`、`dsh-skill-filesystem/README.md` |
| 系统提示 | `dsh-system-prompt/README.md` |
| 客户端模块/平台表 | `dsh-client-modules/README.md`、`dsh-client-modules/lib/index.js`、`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`PLATFORM_MODULES` 静态表） |
| slot/locale/settings 页 | `dsh-client-ui-settings-plugins/lib/client.js`、`dsh-client-ui-plugin-manager/README.md`、`dsh-client-locale/README.md`（slots 类型在本地 checkout `dsh-client-ui-slots`、`dsh-client-ui-renderer`） |
| 依赖安装/回滚 | `dsh-plugin-manager/README.md`、`dsh-plugin-manager/lib/index.js`、`dsh-plugin-manager/lib/types/install-spec.js` |
| HMR | `dsh-hmr/README.md` |
| Electron 壳/日志/恢复 | asar 根 `lib/main.js`（`setAppLogsPath`、`DesktopFatalRecovery`、`disableAllPlugins`）、根 `package.json` |

## 附录 B：本次用到的解包/验证命令

```bash
# 列出 asar（用本地 checkout 的 asar）
cd "/Users/mac/Desktop/项目/dsh-desktop"
node node_modules/.bin/asar list "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" > /tmp/asar-list.txt
grep -E "^/dsh/node_modules/@deepseek-ai/dsh-tools/" /tmp/asar-list.txt

# 按路径抽取单个文件到 /tmp/dsh-extract/<原路径>
node /tmp/extract-dsh.mjs dsh/node_modules/@deepseek-ai/dsh-tools/README.md

# 临时 home 里跑 web profile（不碰用户 profile）
DSH_HOME=/tmp/dsh-scout-home2 dsh --profile web --no-open --host 127.0.0.1 --port 0

# 真实 desktop 组合的只读验证：副本 + dump
rsync -a ~/.dsh/profiles/desktop/ /tmp/dsh-scout-home3/profiles/desktop-copy/
DSH_HOME=/tmp/dsh-scout-home3 dsh --profile desktop-copy --dump-config
```
