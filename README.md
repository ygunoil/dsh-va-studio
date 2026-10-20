# dsh-va-studio

把本地 **VA Studio** 后端接进 **DeepSeek Harness（DSH）** 的第三方插件。装上之后，Agent 可以直接：

- 自动生成**短剧**（一句话 → 项目 + 分镜）
- 自动生成**图片**（文生图 / 图生图，1–4 张，可指定画幅与分辨率）
- 自动生成**视频**（单条 4–30 秒文生/图生视频；短剧项目一键成片）
- 自动生成**小说**（含章节/字数控制，生成后取完整正文）
- 自动生成**剧本**（从创意或已有小说改编）
- **提示词反推**（图片/视频 → 可直接使用的提示词、分镜、角色制作包）
- **提示词扩写**（几个词 → 完整生图/生视频提示词）

插件不内置模型，也不保存生成结果；它把 DSH 的 Agent 接到你已经配置好模型和素材库的 VA Studio 后端上。

## 前置条件

1. DeepSeek Harness `0.2.1-rc.2`（`engines.dsh` 限定 `>=0.2.1-rc.2 <0.3.0`）。
2. 一个可访问的 VA Studio 后端（默认 `http://127.0.0.1:8790`），且已登录账号有对应功能权限。
3. VA Studio 管理端已配置生成所需模型密钥（剧本需要 `screenplay` 功能权限）。

## 安装

### 从 GitHub 安装

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:ygunoil/dsh-va-studio
```

也可以在 DSH 的 **Plugins → Add plugin** 里填 `github:ygunoil/dsh-va-studio`，或填 release 里的 `.tgz` 地址。

### 从本地 tarball 安装

> 推荐在 DSH 的 **Plugins** 页安装：侧边栏 Plugins → **Add plugin** → 输入本包的绝对路径（目录或 `.tgz`）→ 安装 → Enable now。

```bash
# 打包
cd /Users/mac/Desktop/xxt/dsh-va-studio
npm pack --cache /tmp/npm-cache-va-studio --pack-destination dist
# 得到 dist/dsh-va-studio-0.2.0.tgz
```

安装后如果界面没有立即出现新入口，按提示重启 Harness。配置入口有两个：**Settings → Plugins → VA Studio**，或 **Plugins → dsh-va-studio → Configure**。

### 配置连接

打开 **设置 → 插件 → VA Studio**：

| 字段 | 说明 |
|---|---|
| 后端地址 | 例如 `http://127.0.0.1:8790`，不要带 `/api` 或结尾斜杠 |
| 登录方式 | 账号密码，或直接粘贴 VA Studio 的访问令牌 |
| 账号 / 密码 / 令牌 | 保存在本机 Host 的凭据存储中，不会进入对话、日志或提示词 |

点「保存并验证」会先调用后端健康检查，再验证登录；通过后配置才会落盘。

## 安装后可用的工具

| 工具 | 作用 | 成本提示 |
|---|---|---|
| `va_studio_status` | 后端健康、当前账号、功能权限、已配置模型 | 免费 |
| `va_studio_generate_novel` | 一句话 → 小说；返回完整 Markdown | 按章节计费，耗时随章节增长 |
| `va_studio_generate_screenplay` | 创意或小说 → 分集剧本；返回市场版全文 | 按集数计费，可能数分钟 |
| `va_studio_generate_drama` | 一句话剧情 → 短剧项目 + 分镜 | 按 LLM 调用计费，通常 1–10 分钟 |
| `va_studio_generate_image` | 文生图 / 图生图，1–4 张，9:16/16:9/1:1 等画幅 | 按张计费，通常十几秒到数分钟 |
| `va_studio_generate_video` | 单条 4–30 秒视频（文生/图生） | 按条计费，通常数分钟 |
| `va_studio_produce_video` | 短剧项目一键成片（定妆/关键帧/视频/配音/压片） | **最贵最慢**，必须用户明确同意后传 `confirm=true` |
| `va_studio_reverse_prompt` | 图片/视频 → 提示词、分镜、角色制作包 | 视频反推按次计费 |
| `va_studio_expand_prompt` | 短提示词 → 生产级提示词 | 很便宜 |
| `va_studio_job` | 继续等待/查询任意生成任务，完成后取回正文 | 免费 |

长任务采用 `wait_seconds` 预算：超时不会失败，而是返回 `jobId`，让 Agent 继续用 `va_studio_job` 轮询。

## 随包技能

| 技能 | 触发场景 |
|---|---|
| `va-studio` | 生成短剧/视频/小说/剧本，把一句话做成短剧 |
| `va-studio-reverse-prompt` | 提示词反推、看图写提示词、视频反推、扩写提示词 |

技能里写清了成本确认、输出归档、错误码处理和工作流顺序。

## 工作方式

```
DSH Agent
  ├─ 加载 va-studio 技能
  ├─ 调用 va_studio_generate_*（Host 半）
  │    ├─ ctx.credentials 取连接配置（密码/令牌只在 Host）
  │    ├─ POST /api/auth/login → 内存缓存 token（6 天）
  │    ├─ 提交异步任务 → 轮询 /api/drama/jobs/{id}
  │    └─ 取回正文/分镜/视频地址，经 render 返回给模型
  └─ 设置页（Client 半）读写 /api/va-studio.settings|save|test
```

- **凭据**：`ctx.credentials` 单条记录（`dsh-va-studio/connection`），只暴露 `configured/writable`，不回传明文。
- **本地上传**：只允许读当前会话工作区内的普通文件（图片 ≤20MB、视频 ≤120MB），防止把任意主机文件上传出去。
- **错误分类**：`AUTH` / `PERMISSION` / `INSUFFICIENT_POINTS` / `CONFLICT` / `VALIDATION` / `TIMEOUT` / `CONFIRM_REQUIRED` 等稳定错误码，技能里带处理建议。
- **不自动重试昂贵操作**：一键成片、出片类任务失败后不会自动重提。

## 验证状态

本版已在临时 DSH profile 中完成真实安装与启动验证（插件加载、client bundle 下发、设置端点存取、凭据持久化、9 个工具的注册与执行）。详细证据、复现命令与**未验证项**见仓库内的 `docs/verification.md`（开发文档不随 npm 包分发）。

## 开发与验证

```bash
# 依赖解析：本机跑测试时把 Harness 自带的 node_modules 链接进来（打包时不会带上）
# node /path/to/dsh-desktop/node_modules/.bin/asar extract \
#   "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-asar
# ln -s /tmp/dsh-asar/dsh/node_modules node_modules

node --test test/*.test.mjs   # HTTP 客户端 / 错误映射
node --test test/settings.test.mjs    # 凭据记录 / 冲突 / 复用
node --test test/tools.test.mjs       # 10 个工具对 mock VA Studio 的端到端行为
node test/check-client.mjs            # client.js 加载协议与设置页注册
```

`test/mock-va-server.mjs` 是一个可独立运行的 VA Studio 模拟后端，用于离线测试全部工具，不会消耗真实额度。

## 已知边界

- 视频“方案生成”（文本/小说 → 多条视频方案）暂未做成独立工具，当前视频能力是单条片段与短剧项目成片。
- 视频反推使用同步接口：超长视频请先剪短或降低 `max_frames`；异步反推会额外生成角色身份板/故事板图并产生额外成本，本插件暂不调用。
- 生成任务在 VA Studio 服务端继续执行，插件超时或取消不会取消服务端任务；可用 `jobId` 回 VA Studio 任务中心查看。
- 需要登录的媒体文件（项目内文件、成片下载）在浏览器里打开时使用 VA Studio 自己的登录态。

## 目录

```
dsh-va-studio/
├── package.json          # DSH 插件清单（bundle patch / client / engines.dsh）
├── cordis.patch.yml      # 把 Host 半插入 profile 插件树
├── dsh/index.js          # Host 半入口：配置端点、工具、技能、系统提示
├── client/client.js      # Client 半：Settings → Plugins 设置页
├── lib/                  # 凭据、VA Studio HTTP 客户端、工具实现、工作区文件读取
├── skills/               # 随包技能（va-studio、va-studio-reverse-prompt）
├── test/                 # 单元/集成测试 + mock 后端 + client 协议校验
└── docs/                 # 本插件开发期的 API 映射与 DSH 插件指南
```

## License

MIT
