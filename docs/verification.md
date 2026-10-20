# 验证记录（dsh-va-studio 0.2.0）

- 验证时间：2026-10-20
- 目标环境：macOS（arm64）· DeepSeek Harness `0.2.1-rc.2`（`/Applications/DeepSeek Harness.app`）
- VA Studio：`/Users/mac/Desktop/xxt/va-studio`，本地后端 `http://127.0.0.1:8790`
- 插件包：`dist/dsh-va-studio-0.2.0.tgz`（sha256 `c7e48462eba51ccbf04f0bab20b0f52fed16b946837fbd9a406f0889388ad0b2`）
- 所有安装/启动验证都在 `/tmp/dsh-va-home` 的临时 `DSH_HOME` 中完成，**没有修改用户真实 profile**。

## 1. 自动化测试

```bash
node --test test/*.test.mjs     # 28 tests / 28 pass
node test/check-client.mjs      # all client checks passed
```

| 测试文件 | 覆盖 |
|---|---|
| `test/va-client.test.mjs` | URL 归一化、SSE 解析、登录与 token 缓存、402 积分不足、422 校验错误、错误密码 |
| `test/settings.test.mjs` | 凭据记录读写、revision 冲突、密码复用、令牌模式、只读拒绝、真实健康+登录校验 |
| `test/tools.test.mjs` | 10 个工具全部定义 + 对 mock VA Studio 的完整调用链（小说/剧本/短剧/图片文生图+图生图/视频/出片/反推三种输入/任务续查） |
| `test/check-client.mjs` | client bundle 协议、`settings.plugins.tab` 与 `plugins.row.config` 注册、locale、CSS、disposer |

mock 后端可独立运行：`node test/mock-va-server.mjs`（默认随机端口，`PORT=18790` 固定端口）。

## 2. 打包

```bash
npm pack --cache /tmp/npm-cache-va-studio --pack-destination dist
tar -tzf dist/dsh-va-studio-0.2.0.tgz
```

tarball 共 13 个文件、约 33 KB，包含 `dsh/`、`client/`、`lib/`、`skills/`、`cordis.patch.yml`、README、LICENSE；不含测试与 docs。

## 3. 临时 profile 安装与真实启动（L2）

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-va-home "$DSH" plugin --profile web add \
  /Users/mac/Desktop/xxt/dsh-va-studio/dist/dsh-va-studio-0.2.0.tgz
# -> dependencies: + dsh-va-studio 0.1.0 (pnpm 11.28.5)
# -> dsh.profile.bundles 追加 dsh-va-studio（自动启用）

DSH_HOME=/tmp/dsh-va-home "$DSH" --profile web --no-open --host 127.0.0.1 --port 0
# -> dsh web: http://127.0.0.1:52138/?token=...
```

| 检查 | 结果 |
|---|---|
| 启动日志出现插件激活失败 | 未出现 |
| 首页 `GET /`（token 换 cookie） | 200 |
| boot graph 含插件 client bundle | `{"id":"dsh-va-studio","url":"plugins/??dsh-va-studio/client.js&rev=...","inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings-plugins"]}` |
| `GET /plugins/??dsh-va-studio/client.js&rev=...` | 200，17,211 B，含 `settings.plugins.tab` ×2、`plugins.row.config` ×2 |
| `GET /api/va-studio.settings`（未配置） | 200，`configured:false`，默认 `http://127.0.0.1:8790` |
| `POST /api/va-studio.save`（指向 mock 后端 + 正确密码） | 200，`configured:true`，`revision:1`，只返回 `hasPassword:true`，不回传明文 |
| 重启 Host 后再次 `GET /api/va-studio.settings` | 200，配置仍在（`configured:true`） |
| `POST /api/va-studio.save`（错误密码） | 401，`{"code":"AUTH","error":"VA Studio 登录失效：账号或密码错误"}` |
| `POST /api/va-studio.test` | 200，`{"ok":true,...}` |

## 4. 工具注册与执行（真实 Host 进程）

在临时 profile 中额外安装了一个**仅用于验证**的探针插件（位于 `/tmp/va-tools-probe`，未随交付），在 Host 内通过 `ctx.tools.get(...)` 取出插件工具并执行：

| 检查 | 结果 |
|---|---|
| 10 个工具全部可见 | `va_studio_status` / `generate_novel` / `generate_screenplay` / `generate_drama` / `generate_image` / `generate_video` / `produce_video` / `reverse_prompt` / `expand_prompt` / `job` 均为 `true` |
| `va_studio_status` 执行 | 返回 `ok:true`、`username:"tester"`、mock 健康信息、`aiSummary` |
| `va_studio_expand_prompt` 执行 | 返回 mock 扩写结果 |
| `va_studio_generate_novel` 执行 | 建记录 → 提交 → 轮询 → 取回 Markdown 全链路成功 |
| `va_studio_generate_image` 执行 | 文生图提交 `/api/image/generate/async` → 轮询 `/api/image/jobs/{id}` → 返回 1 张图的绝对 URL（1024×1024） |

## 5. 真实 VA Studio 只读契约

```bash
node --input-type=module -e "import('./lib/va-client.js').then(async m => console.log(await m.health('http://127.0.0.1:8790')))"
# -> status:"ok", maxVideoSeconds:900, arkApiKey:true,
#    aiKeys: llm_doubao / vision_doubao / t2v_seedance / video_seedance / t2i_seedream / tts_volc = true
```

健康检查与公开接口契约与 `docs/api-map.md` 一致；带登录的生成链路未用真实账号执行（见下）。

## 5.1 生产环境接口面核对（只读）

目标：`https://vastudio.thchengtay.com`

| 检查 | 结果 |
|---|---|
| `GET /api/drama/health` | 200，TLS 校验证通过，`status:"ok"`，模型密钥齐全（doubao/seedance/grok/jimeng/gpt-image 等） |
| `POST /api/auth/login`（错误账号） | 401「账号或密码错误」，与本地同一契约 |
| 生产前端构建中的插件端点 | 命中 `/api/novel/stream`、`/api/screenplay/stream`、`/api/drama/chat/jobs`、`/api/drama/jobs/`、`/api/video/clip/generate/async`、`/api/video/clip/jobs/`、`/api/video/clip/upload`、`/api/video/prompt-from-image(-file)`、`/api/video/prompt-from-video(-file)`、`/api/video/prompt-reverse/jobs/`、`/api/prompt/expand`、`/api/image/generate/async`、`/api/image/jobs/`、`/api/image/upload`、`/api/image/files/`、`autopilot`、`download/mp4` |
| 带生产账号的生成调用 | 未执行（需要用户自己的账号，且会扣生产积分） |

说明：生产比本地多了 grok / jimeng / gpt-image 等模型，插件按 VA Studio 返回的能力列表工作，不写死模型。

## 6. 未验证项（如实列出）

| 项 | 原因 | 下一步 |
|---|---|---|
| 用真实 VA Studio 账号执行生成（小说/剧本/短剧/视频/反推） | 本次没有账号密码，且生成会消耗真实积分；不做未经授权的付费调用 | 用户在设置页登录后，在会话里让 Agent 执行一次最小生成 |
| 真实 `~/.dsh/profiles/desktop` 安装 | 应用正在运行，避免与 Electron 写 profile 并发 | 从 Plugins 页安装 tarball，按提示重启/热加载 |
| 设置页在真实 UI 中的渲染 | 需要真实页面加载渲染 | 安装后打开 Settings → Plugins 或 Plugins → 本 bundle → Configure |
| 模型在真实会话中选择并调用工具 | 需要真实会话与模型额度 | 新会话输入“用 va-studio 生成一个 1 章小说” |
| 视频/一键成片真实出片 | 成本最高、耗时最长，且需要真实账号 | 用户明确确认后单独验证 |
| 视频反推“方案生成”工具 | 本版未实现（见 README 已知边界） | 后续按 `/api/video/generate` + `/api/video/render-plan` 增加 |

## 7. 复现命令

```bash
cd /Users/mac/Desktop/xxt/dsh-va-studio
node --test test/*.test.mjs
node test/check-client.mjs
npm pack --cache /tmp/npm-cache-va-studio --pack-destination dist

# 临时 profile 演练（不碰真实 profile）
rm -rf /tmp/dsh-va-home
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/dsh-va-home "$DSH" plugin --profile web add "$PWD/dist/dsh-va-studio-0.2.0.tgz"
DSH_HOME=/tmp/dsh-va-home "$DSH" --profile web --no-open --host 127.0.0.1 --port 0

# mock 后端（另一个终端）
PORT=18790 node test/mock-va-server.mjs
```
