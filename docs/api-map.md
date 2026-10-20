# VA Studio 后端 API 映射（供 DSH 插件调用）

> 调研对象：`/Users/mac/Desktop/xxt/va-studio`，后端 commit `f5141d9`（2026-10-15），
> 本地运行实例 `http://127.0.0.1:8790`（`api_server:app` → `api.main:app`，见 `backend/api_server.py:1`）。
> 调研时间：2026-10-20。**只读调研**：未改业务代码、未写数据库、未创建用户、未触发任何生成任务。
>
> 标注约定：
> - ✅ **实测**：本机 curl / OpenAPI / 只读 SQLite 聚合直接验证。
> - 🧪 **OpenAPI**：从运行实例的 `/openapi.json`（公开，423 个 path）取到的当前生效 schema。
> - 📖 **读码**：源码结论，未在运行实例上做带鉴权的实测。
> - 🗄️ **历史库统计**：只读查询本机 `backend/storage/drama.db` 的 `jobs` 表，样本很小，只作量级参考。
>
> 行号统一相对 `va-studio` 仓库根；章节内表格里的短文件名（如 `novel.py:179`、`drama.py:410`）均指该章节开头“源码：”声明的那个文件。
>
> 重要限制：本次没有可用登录凭据，因此**所有需要登录的接口响应体均未做在线实测**（响应结构来自源码 + OpenAPI + 前端解析代码 + 历史任务行的 `result_json`）。
> 任何“POST 会产生任务”的请求都未发送。

---

## 0. 结论速查（插件工具 ↔ 推荐端点）

| 能力 | 推荐端点（插件主路径） | 形态 | 拿结果的方式 | 耗时量级 |
|---|---|---|---|---|
| 小说生成 | `POST /api/novel/records` → `POST /api/novel/stream` | 异步 job（**不是 SSE**） | 轮询 `GET /api/drama/jobs/{jobId}` → `GET /api/novel/records/{id}/markdown` | 随章节数线性增长；本机历史中位 632s、最长 5016s（🗄️） |
| 小说导出 | `GET /api/novel/records/{id}/export?format=md\|docx\|pdf` | 同步下载 | 直接落文件 | 秒级 |
| 剧本生成 | `POST /api/screenplay/stream` | 异步 job（返回 `jobId`+`screenplayId`） | 轮询 job → `GET /api/screenplay/records/{id}`（`marketText`/`standardText`） | 中位约 10 分钟，p90 约 27 分钟（🗄️） |
| 小说转剧本 | `POST /api/screenplay/stream`（`sourceType:"novel"`+`novelId`） | 异步 job | 同上 | 同上 |
| 剧本转短剧项目 | `POST /api/screenplay/{id}/to-drama` | 同步（纯结构转换） | 响应里直接有 `project` | 秒级 |
| 剧本转分镜表 | `POST /api/screenplay/{id}/to-storyboard` | 同步（纯结构转换） | 响应里直接有 `storyboard` | 秒级 |
| 一句话生成短剧（含分镜） | `POST /api/drama/chat/jobs` | 异步 job | 轮询 job → `result.donePayload.projectId` → `GET /api/drama/project/{id}` | 中位约 81 秒，p90 约 9.6 分钟（🗄️） |
| 短剧项目内润色/改分镜 | `POST /api/drama/chat/jobs`（带 `projectId`）或 `/chat/stream`（SSE） | job / SSE | 同上 | 数十秒～数分钟 |
| 短剧一键成片 | `POST /api/drama/project/{id}/autopilot` | 异步 job | 轮询 job → `result.mp4Path` → `GET /api/drama/project/{id}/download/mp4` | 分钟～数十分钟（受镜头数与厂商影响） |
| 单镜出片 | `POST /api/drama/project/{id}/shots/{shotId}/generate` | 异步 job | 轮询 job → 项目详情 `shots[].render.localPath` | 中位约 6 分钟（🗄️） |
| 视频（分镜方案） | `POST /api/video/generate` | **同步**，只出方案 | 响应 `videoPlan` | LLM 数十秒～数分钟 |
| 视频（方案+出片） | `POST /api/video/generate`（`submitVideoJobs:true`）或 `POST /api/video/render-plan` | 同步阻塞 | `videoPlan.videos[].renderDownloadUrl` | 每条视频可达 `videoPollMaxSeconds`（默认 1800s） |
| 视频（单片段，异步） | `POST /api/video/clip/generate/async` → `GET /api/video/clip/jobs/{id}` | 异步 job | `result.items[0].result.videoUrl` | 数分钟（🗄️ 出片类中位约 4～6 分钟） |
| 提示词反推（图片 URL/文件） | `POST /api/video/prompt-from-image` / `...-image-file` | 同步 | 响应 `plainTextPrompt` + `imagePrompt` | 10～60 秒 |
| 提示词反推（视频 URL/文件） | `POST /api/video/prompt-from-video` / `...-from-file` | 同步 | 响应 `plainTextPrompt` + `videoSpec` | 抽帧+VL（drama 模式再加 ASR/OCR/台词分配），秒级～数分钟；本机唯一一条图片反推 job 25.6s（🗄️） |
| 提示词反推（长任务/批量） | `.../async` + `GET /api/video/prompt-reverse/jobs/{jobId}` | 异步 job | `result.items[].result` | 同上；**视频**反推的 `drama`/`visual` 模式还会额外生成身份板/故事板图（更慢/更贵） |
| 提示词扩写 | `POST /api/prompt/expand` | 同步 | 响应 `prompt` | 数秒～20 秒 |

---

## 1. 鉴权与通用约定

### 1.1 登录 / token / `me`

| 方法 | 路径 | 登录 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 否（白名单） | 请求体 `{username\|identifier, password}`，返回 `token` 等 |
| POST | `/api/auth/register` | 否（白名单） | 注册（本插件不应调用） |
| GET | `/api/auth/me` | **是** | 当前用户 + 积分/会员信息 |
| POST | `/api/auth/password` | 是 | 改密码 |

登录请求体（`backend/api/routes/auth.py:40-43`，🧪）：

```jsonc
{
  "username": "",      // 可选，maxLength 120
  "identifier": "",    // 可选（账号或手机号），与 username 二选一，优先 identifier
  "password": "..."    // 必填，minLength 1
}
```

`identifier` 为空时用 `username`；两者都空返回 400 `{"detail":"请输入账号或手机号"}`；
账号密码错误返回 **401** `{"detail":"账号或密码错误"}`（✅ 实测，已用不存在的账号验证）。

登录成功响应（`_auth_payload`，`backend/api/routes/auth.py:64-83`，📖）：

```jsonc
{
  "token": "<base64url_body>.<hmac_sha256_hex>",
  "expiresIn": 604800,        // 7 天（auth.py:37 TOKEN_TTL_SEC）
  "username": "...", "phone": "...", "id": "...",
  "role": "...", "roleId": "...", "roleName": "...", "isAdmin": false,
  "adminMenus": [], "featurePerms": [], "features": ["screenplay", "..."],
  "membership": { ... },
  "pointsAvailable": 0, "pointsReserved": 0   // 来自 billing.account()，字段随账号模块
}
```

- token 是自签 HMAC：`base64url(json{uid,u,exp}).hmac_sha256(secret)`，secret 取 `APP_AUTH_SECRET`，默认开发值见 `backend/api/auth_token.py:15-17`；有效期 7 天（`auth_token.py:28-41`，`auth.py:37`，📖）。
- 请求头：`Authorization: Bearer <token>`；`extract_bearer` 大小写不敏感（`auth_token.py:74-82`）。
- **额外支持 query 参数 `access_token`**（`backend/api/main.py:317-319`，📖）——浏览器 `<img>/<video>` 无法带头，前端就是用它拼直链的（`frontend/src/auth/session.js:34-42`）。插件优先用 Header，只有需要把媒体 URL 交给浏览器/下载器时才拼 `?access_token=`。
- `/api/auth/me` 返回 `{ok:true, id, username, role, roleId, roleName, isAdmin, adminMenus, featurePerms, features, membership, ...account}`（`auth.py:142-165`，📖）。
- token 校验除签名/过期外，还要求用户仍存在、`is_active` 且 `username` 匹配（`auth_token.py:63-66`），所以改用户名/禁用会立刻失效。

### 1.2 是否所有 `/api` 都要登录：白名单（`backend/api/main.py:192-207`，✅ 部分实测）

下面的路径**不需要**登录（中间件直接放行）：

```
/api/auth/login
/api/auth/register
/api/client-errors
/api/drama/health
/api/config/site
/api/membership/alipay/notify
/api/config/site-videos/...              (前缀)
/api/video/clip/files/...                (前缀)
/api/image/files/...                     (前缀)
/api/digital-human/files/...             (前缀)
/api/digital-human/public/scenes/...     (前缀)
/api/audio/files/catalog/...             (前缀)
```

其余**所有** `/api/*`（含未知路径）都先过鉴权（`main.py:312-343`）：

- 不带 token → 401 `{"detail":"未登录或登录已过期"}`（✅ 实测）。
- 带无效/过期 token → 同样 401（✅ 实测）。
- **坑**：因为鉴权中间件先于路由匹配，未登录时请求不存在的 `/api/xxx` 也返回 **401 而不是 404**；用 GET 打只在 POST 注册的路由也返回 **401 而不是 405**（✅ 实测 `GET /api/novel/stream` → 401）。排查“路径写错”时一定要带合法 token 再请求一次。
- `/api/health` **不存在**（白名单里也没有它，所以返回 401）。探活正确姿势是公开的 **`GET /api/drama/health`**（✅ 实测 200），插件现有 `lib/va-client.js:74` 用的就是它。

公开的其它信息面：
- `GET /openapi.json`、`GET /docs` 不在 `/api` 前缀下，**无需登录即可访问**（✅ 实测 200，423 个 path）。插件调试/契约校验可以直接拉，但不要把这条当成产品依赖。
- `GET /api/drama/health`（✅ 实测 200，缓存 30s，`backend/api/routes/drama.py:240,345-372`）返回 `status / maxVideoSeconds(900) / maxDramaShots(300) / ffmpeg / subtitleBurn / aiKeys{...}`。**`aiKeys` 可直接判断哪些模型/厂商已配置**（如 `video_seedance`、`vision_doubao`、`llm_doubao`），适合插件做能力预检。
- `GET /api/config/site`（✅ 实测 200）返回登录页背景等站点配置。

### 1.3 401 / 402 / 403 / 409 / 429 行为

| 状态 | 触发 | 响应体 | 来源 |
|---|---|---|---|
| 401 | 无 token / token 无效/过期 / 用户被禁用 | `{"detail":"未登录或登录已过期"}` | `main.py:340-342`（✅） |
| 402 | 非管理员积分不足（计费接口预扣失败） | `{"code":"INSUFFICIENT_POINTS","detail":"...","requiredPoints":N,"availablePoints":M,"operation":"video","openMembershipOnInsufficientPoints":bool}` | `main.py:365-377`（📖） |
| 403 | 剧本接口缺 `screenplay` 功能权限 | `{"detail":"无剧本 Agent 使用权限"}` | `backend/api/routes/screenplay.py:68-76`（📖） |
| 404 | 资源不存在（需已登录）/ 未知 `/api` 路由（已登录） | `{"detail":"小说不存在"}` / `{"detail":"Not Found"}`；SPA 兜底会改写成 `{"detail":"API 路由不存在或后端服务尚未加载最新路由","path":"..."}` | `main.py:575-589`（📖） |
| 409 | 同一小说并发生成 / autopilot 重复提交 | `{"detail":"..."}` | `services/novel/queue.py:80-81`、`api/routes/drama.py:6017-6024`（📖） |
| 422 | Pydantic 字段校验失败 | FastAPI 标准 `{"detail":[{"loc":...,"msg":...}]}` | 🧪 |
| 429 | 小说提交限流：每 IP 60 秒 24 次 | `{"detail":"请求过于频繁，请 60 秒后再试（每 IP 每分钟约 24 次流式生成）"}` | `services/novel/rate_limit.py:1-18`、`services/novel/settings.py:4-5`（📖） |

**计费（会先预扣积分，失败即 402）**的关键路径（`backend/services/billing.py:296-365`，📖）：
`/api/novel/stream`、`/api/screenplay/stream|from-story-graph|quality-repair|revise-scene|to-storyboard`、`/api/video/stream|generate|render-plan|from-file/stream`、`/api/video/clip/generate*`、`/api/video/prompt-from-*`（反推）、`/api/drama/**/reverse-prompt*`、`/api/drama/chat/(stream|jobs)`、`/api/drama/novel/*`、`/api/drama/project/{id}/shots/{shotId}/generate`、`/api/prompt/expand`。
读、上传、导出、轮询、取消**不计费**。
管理员不受预扣限制（`main.py:349`）。

### 1.4 CORS 与 SSE

- CORS：`allow_origins=["*"]`、`allow_credentials=true`、`allow_methods/headers=["*"]`（`main.py:591-598`）。✅ 实测预检 `OPTIONS /api/novel/records` → 200，返回 `access-control-allow-origin: http://localhost:5173`、`allow-credentials: true`、`max-age: 600`。本地 `vite` 把 `/api` 代理到 8790（`frontend/vite.config.js:98-113`）。
- SSE 统一格式（`backend/tools/sse.py:13-22`）：

```
event: <name>\n
data: <单行 JSON>\n
\n
```

  心跳是注释行 `: heartbeat\n\n`；带 id 的任务流是 `id: <seq>\nevent: ...\ndata: ...\n\n`。前端解析器 `frontend/src/utils/sseClient.js` 与插件 `lib/va-client.js:parseSseBlock` 都按 `\n\n` 分帧、忽略 `:` 注释行。
- SSE 响应头：
  - 视频/剪辑/短剧/任务流：`Cache-Control: no-cache, no-store, must-revalidate`、`Connection: keep-alive`、**`X-Accel-Buffering: no`**（`api/routes/video.py:125-129`、`api/routes/drama.py:311-315`）。
  - 小说 `/api/novel/review`：只有 `Cache-Control: no-cache`、`Connection: keep-alive`（`api/routes/novel.py:286-290`）。
  - **坑（实测/OpenAPI）**：`/openapi.json` 把所有 SSE 接口都声明为 `application/json`（因为没有 `response_model`），不能拿它判断“是不是流式”。真正判断依据是运行时 `content-type: text/event-stream; charset=utf-8`。
- 前端本地开发还会在代理层补 `cache-control: no-cache, no-transform` 与 `x-accel-buffering: no`（`frontend/vite.config.js:104-111`）。自建 nginx/网关反代时也要 `proxy_buffering off`，否则 SSE 会攒包。
- POST SSE 不能用浏览器 `EventSource`（它只支持 GET），前端是 `fetch` + ReadableStream（`sseClient.js:48-100`）。插件同理；Node 侧用 `lib/va-client.js` 的 `stream()`。

### 1.5 任务（job）模型：所有长任务的统一套路

`JobRecord`（`backend/api/drama_schemas.py:1513-1524`，🧪；真机 `result_json` 校验 ✅）：

```jsonc
{
  "id": "uuid",
  "projectId": "uuid 或 studio:xxx 占位",
  "type": "storyboard | shot_generate | novel_generate | screenplay_generate | autopilot | batch_autopilot | video_clip | image_studio | prompt_reverse | capcut | compose | audio_tts | ...",
  "status": "queued | running | done | error",   // 只有这 4 个
  "progress": 0.0,                                 // 0~1
  "message": "人类可读进度",
  "result": { ... },                               // 见各能力章节；含 retryPayload/apiKey 已剔除
  "ownerUserId": "...",
  "createdAt": "ISO8601", "updatedAt": "ISO8601"
}
```

统一轮询与取消接口（`backend/api/routes/drama.py`，📖）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/drama/jobs/{jobId}` | 返回 `{"job": JobRecord}`。任务中心**通用**，小说/剧本/短剧/出片/反推/剪辑都能查；仅本人或管理员（否则 403）；任务不存在 404。剧本任务会做“长时无响应”过期改写（`drama.py:7200-7212`）。 |
| GET | `/api/drama/jobs/{jobId}/stream` | SSE：先 `progress`/`done`/`error`，之后 `progress` 增量，20s 无事件发 `: heartbeat`（`drama.py:7357-7411`）。 |
| POST | `/api/drama/jobs/{jobId}/cancel` | 取消/暂停；对不同 type 有专门收尾（小说/剧本会标记 paused 可续写）。 |
| POST | `/api/drama/jobs/{jobId}/retry` | 用 `retryPayload` 重提，返回新 `jobId`。 |
| GET | `/api/task-center/job/{jobId}` | 另一个任务中心视图，返回更“展示友好”的 `{"job": {...}}`（`api/routes/task_center.py:14-19`，📖）。 |
| GET | `/api/drama/tasks?scope=all\|active\|recent&limit=50` | 当前用户任务列表 `{"tasks":[...], "activeCount":N}`（`drama.py:7152-7169`）。 |
| GET | `/api/drama/tasks/stream` | SSE 任务快照 + 增量（`drama.py:7172-7197`）。 |

批量型任务（反推/图片/剪辑出片）用 `services/batch_jobs.py` 的批次结构（真机 `image_studio`/`prompt_reverse` 的 result 已核对 ✅）：

```jsonc
"result": {
  "clientIds": ["slot-0"],
  "items": [
    {"index":0, "clientId":"slot-0", "status":"queued|running|done|error",
     "progress":1.0, "message":"", "result": {...该项业务结果...}, "error":""}
  ],
  "total": 1, "current": 1,
  "results": [ ...done 项的 result 平铺... ],
  "errors":  [ {"index":0,"error":"..."} ],
  "payload": { ...单项兼容字段，done 的第一项 result... },
  "ttlSec": 3600, "deadlineAt": "ISO8601"   // 反推/出片这类任务会带，TTS 等可为空
}
```

> 轮询建议：1.5～3 秒一次（前端小说轮询就是 1.5s，`frontend/src/pages/NovelPage.jsx:1694-1754`）。`GET /api/drama/jobs/{id}` 不计费、足够便宜。
> **不要在插件里靠 SSE 判断完成**：`done`/`error` 事件的 payload 在不同接口里字段不一致，而 job 轮询的 `status` 是统一真相。

### 1.6 媒体文件 URL 约定（插件拿“成品”时最常踩）

| 类型 | 相对/公开 URL | 是否要登录 | 来源 |
|---|---|---|---|
| 剪辑/单片段成品 | `/api/video/clip/files/<video_clips/...>` | **公开**（白名单前缀） | `services/media_materialize.py:13`、`main.py:198-199`（✅ 实测 404 而非 401） |
| 图片工作台成品 | `/api/image/files/<...>` | **公开** | `main.py:199`、`api/routes/image.py`（✅） |
| 影视项目内文件 | `/api/drama/project/{projectId}/files/{相对路径}`；`?download=1`、`?preview=1`、`?thumbnail=1` | **要**（Header 或 `?access_token=`） | `backend/api/routes/drama.py:6476-6572` |
| 项目成片 mp4 | `/api/drama/project/{projectId}/download/mp4` | **要** | `drama.py:6572-6587` |
| 小说导出 | `GET /api/novel/records/{id}/export?format=md\|docx\|pdf` | **要** | `novel.py:443-483` |
| 剧本导出 | `GET /api/screenplay/records/{id}/export?format=md\|docx\|pdf` | **要** | `screenplay.py:834-877` |
| 数字人成品 | `/api/digital-human/files/...` | **公开** | `main.py:201-203` |

生成类结果里通常同时给：
- `videoUrl` = 可直接播放/下载的 `/api/video/clip/files/...`（**无鉴权**，适合直接交给用户或做缩略图）；
- `path` = 存储相对路径（`video_clips/...`），后续可传给 `imagePath/refImagePaths/sourceVideoPath` 等字段；
- `remoteUrl` = 厂商临时地址，**只作诊断**，会过期，不要持久化。

---

## 2. 小说（novel）

源码：`backend/api/routes/novel.py`；生成引擎 `backend/services/novel/`；记录库 `backend/services/novel/tools/novel_db.py`。
请求模型：`backend/services/novel/schemas.py`（`StreamRequest:75-133`）。

> ⚠️ **与任务书假设不一致（最重要的一条）**：`POST /api/novel/stream` **现在不是 SSE**。
> 它只做“提交任务”，同步返回 JSON `{jobId, novelId, status, message, queueAhead}`（`novel.py:179-184` → `services/novel/queue.py:38-104`）。
> 代码里仍保留 SSE 事件生成器（`novel_sse_generator`），但事件被后台队列线程消费、写入草稿，不再透传给 HTTP 客户端。
> 前端也是按“JSON + 轮询”处理的，并且兼容老版 SSE（`frontend/src/pages/NovelPage.jsx:1759-1798` 先看 `content-type` 是否 `text/event-stream`）。🧪 OpenAPI 也显示该接口 200 为 `application/json`。

### 2.1 端点清单

| 方法 | 路径 | 登录 | 形态 | 说明 | 出处 |
|---|---|---|---|---|---|
| POST | `/api/novel/stream` | 是 | **异步 job** | 提交生成，返回 `jobId`；同用户最多 5 个并发，超出排队 | novel.py:179-184 / queue.py:22,38-104 |
| POST | `/api/novel/review` | 是 | **真 SSE** | 手工投稿评测（对已有正文），事件 `review_started/review_complete/done/error` | novel.py:187-290 |
| POST | `/api/novel/import` | 是 | 同步 multipart | 导入 TXT/PDF/DOC/DOCX 抽文本 | novel.py:293-308 |
| POST | `/api/novel/export/word` | 是 | 同步下载 | 传裸 markdown 导出 docx | novel.py:311-332 |
| POST | `/api/novel/export/pdf` | 是 | 同步下载 | 传裸 markdown 导出 pdf | novel.py:335-359 |
| GET | `/api/novel/records` | 是 | 同步 | 分页列表，`?page&pageSize(≤100)&scope=all\|in_work\|independent` | novel.py:362-379 |
| POST | `/api/novel/records` | 是 | 同步 | 新建记录（可先建“生成中”占位） | novel.py:382-420 |
| GET | `/api/novel/records/{id}` | 是 | 同步 | 详情（**不含 markdown 正文**，含 `chapterList` 全章 markdown、`submissionReport` 等） | novel.py:423-430 / novel_db.py:345-402,679-705 |
| GET | `/api/novel/records/{id}/markdown` | 是 | 同步纯文本 | **取完整正文的唯一推荐接口**，`text/markdown; charset=utf-8` | novel.py:433-440 |
| GET | `/api/novel/records/{id}/export` | 是 | 同步下载 | `?format=md\|docx\|pdf`，从记录取正文导出 | novel.py:443-483 |
| PATCH | `/api/novel/records/{id}` | 是 | 同步 | 更新记录（可写 `markdown`、`status` 等） | novel.py:486-541 |
| DELETE | `/api/novel/records/{id}` | 是 | 同步 | 删除 | novel.py:544-551 |
| POST | `/api/novel/records/import` | 是 | 同步 JSON | `{items:[...]}` 批量导入记录 | novel.py:554-560 |
| GET | `/api/speech/baidu-asr/status`、`GET /api/speech/volc-asr/status` | 是 | 同步 | ASR 配置探测 | novel.py:563-600 |
| POST | `/api/speech/baidu-asr`、`/api/speech/volc-asr` | 是 | 同步 multipart | 上传音频转写（≤8MB） | novel.py:571-632 |

### 2.2 `POST /api/novel/stream` 请求字段（`StreamRequest`，🧪 OpenAPI 与源码一致）

```jsonc
{
  "idea": "一句话创意",              // ★必填（或给 resumeMarkdown 续写）
  "title": "",
  "style": "balanced",               // 风格 key（默认 balanced）
  "chapters": 50,                    // ≥1，默认 50
  "wordsPerChapter": 2000,           // ≥1000（MIN_CHAPTER_WORDS，schemas.py:71 / style_guides.py:3）
  "autoContinue": true,
  "chapterMaxRetries": 3,
  "retryWaitSeconds": 2.0,
  "model": "", "apiBaseUrl": "", "apiKey": "",   // 可空，用平台配置
  "fastMode": true,                  // true 走快速模式（跳过规划图）
  "summaryInterval": 3,
  "fastWordFactor": 0.6,             // 0.3~1.0
  "resumeMarkdown": "",              // 续写：已有正文
  "resumeRunningSummary": "",
  "resumeChapter": 0,
  "resumeChapterCompleted": false,
  "resumeChapterPlan": [],
  "outlineModel": "",
  "consistencyCheck": true,
  "consistencyMaxRetries": 2,        // 0~5
  "punchyMode": true,
  "novelRecordId": "",               // ★强烈建议传：否则不会落小说记录（见 2.4）
  "platform": "fanqie",              // fanqie|zhihu|qidian
  "workMode": "serial",              // short|medium|serial（影响每章篇幅/规划，graph/nodes.py:30-35）
  "storyPattern": "general",         // general|shuang|shiqing|sweet|angst|regret|suspense|dead_protagonist
  "submissionReview": true
}
```

响应（`services/novel/queue.py:98-104`，📖）：

```jsonc
{"jobId":"uuid","novelId":"<回显 novelRecordId>","status":"queued|running","message":"排队中/正在生成小说","queueAhead":0}
```

并发/排队：同用户最多 `NOVEL_MAX_RUNNING=5` 个 running，其余保持 `queued`（`queue.py:22,107-151`）；同一 `novelRecordId` 已有活动任务会 **409**（`queue.py:80-81`）；限流 24 次/分钟/IP → 429。
一旦提交，生成**不绑定 HTTP 连接**：断开请求不会取消任务（`queue.py:1-5`）。

### 2.3 生成过程中的事件（内部 SSE，理解用；HTTP 不可见）

`services/novel/stream.py` 里全部事件名（📖，正则枚举）：
`status`、`job`、`outline`、`summary`、`title`、`synopsis`、`resume_sync`、`chapter`、`chapter_chunk`、`chapter_discard`、`review_started`、`review_complete`、`revision_started`、`revision_complete`、`progress`、`done`、`error`。
关键 payload：`title{title}`、`synopsis{markdown}`、`resume_sync{title,body}`、`chapter{chapter,markdown}`、`chapter_chunk{chapter,delta}`、`done{title,markdown,submissionReport?,assetId?}`、`error{message}`。
`done` 的 `markdown` 是**完整正文**（`stream.py:1083-1114`），但只被后台 `_consume_chunk`（`queue.py:268-292`）拿去写 `novelRecordId` 对应记录的检查点（每 2 秒落一次，`queue.py:295-319`）。
如果插件连接的是**旧版**后端（SSE 回退分支），事件格式就是这套；当前版本按 JSON 处理即可。

### 2.4 「一次生成后如何拿到完整正文」——最短路径

结论：**流式拼接是不必要的**。正确链路是「先建记录 → 提交 job → 轮询 → 读 `/markdown`」：

```bash
BASE=http://127.0.0.1:8790
TOKEN='...'   # POST /api/auth/login 拿到的 token

# 1) 先建记录（否则 novelRecordId 为空，生成结果不会落库，只能靠 job 结果看不出正文）
curl -s -X POST "$BASE/api/novel/records" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"测试小说","chapters":1,"wordsPerChapter":1000,"status":"generating"}'
# -> {"item":{"id":"<NOVEL_ID>", ...}}

# 2) 提交生成（立刻返回，不是 SSE）
curl -s -X POST "$BASE/api/novel/stream" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "idea":"外卖员捡到一块能看见死亡倒计时的旧手表",
        "title":"倒计时手表","chapters":1,"wordsPerChapter":1000,
        "workMode":"short","fastMode":true,"submissionReview":false,
        "novelRecordId":"<NOVEL_ID>"
      }'
# -> {"jobId":"<JOB_ID>","novelId":"<NOVEL_ID>","status":"queued|running","message":"...","queueAhead":0}

# 3) 轮询 job（scripts 里 1.5~3s 一次）
curl -s "$BASE/api/drama/jobs/<JOB_ID>" -H "Authorization: Bearer $TOKEN"
# -> {"job":{"status":"running|done|error","progress":0.42,"message":"...","result":{...}}}

# 4) 完成后取正文（纯文本，最省事）
curl -s "$BASE/api/novel/records/<NOVEL_ID>/markdown" -H "Authorization: Bearer $TOKEN"
```

- `job.status=="done"` 时 `job.result` 实测形如（真机历史行 ✅）：
  `{title, novelTitle, href, novelId, platform, workMode, storyPattern, retryPayload, modelUsage[], ownerUserId, assetId}`。
  **`job.result` 里没有正文**，正文只在记录文件里。
- 正文落盘时机：每 2 秒 checkpoint + `done` 时强制 flush（`queue.py:295-319`）。因此**任务进行中也可以**调 `/markdown` 拿已完成部分（前端就是这么做的，`NovelPage.jsx:1708-1716`），适合做“边生成边展示”。
- 若忘了传 `novelRecordId`：任务仍会跑，但不会创建小说记录；`done` 后正文只进了素材库（`stream.py:1057-1082` 的 ingest 逻辑），**没有稳定接口取回**。所以插件必须“先建记录”。
- 记录详情 `GET /api/novel/records/{id}` 返回的 `chapterList:[{index,title,markdown}]` 也含全章文本（`novel_db.py:103-120,393-396`），但体积大且是数组，不如 `/markdown`；且详情**没有** `markdown` 顶层字段（`novel_db.py:345-402`）。

### 2.5 导出 / 导入

- 记录导出：`GET /api/novel/records/{id}/export?format=md|docx|pdf`（`novel.py:443-483`；`services/novel/tools/docx_export.py:45-61` 支持 `md/markdown/docx/pdf`，其它 400）。返回二进制 + `Content-Disposition: attachment; filename*=UTF-8''...`。
- 裸文本导出：`POST /api/novel/export/word|pdf`，请求体 `{markdown:"...", fileName:"novel.docx"}`（`ExportWordRequest`，🧪）。适合插件已经拿到 markdown、想绕过记录直接生成文件。
- 导入：`POST /api/novel/import`，`multipart/form-data`，字段名 **`file`**；支持 `.txt/.pdf/.doc/.docx`，≤25MB、≤50 万字（`services/screenplay/importer.py:14-16,228-261`）。响应 `{"item":{"fileName","extension","size","pageCount","text","detected":{...}}}`。
- 批量导入记录：`POST /api/novel/records/import` `{items:[{...}]}`（`novel.py:554-560`）。

### 2.6 小说坑清单

1. `/api/novel/stream` 不是 SSE，是 job 提交；名字里的 stream 是历史遗留。
2. 不传 `novelRecordId` 就没有记录可查正文。
3. `/api/novel/health` 不存在；探活用 `/api/drama/health`。
4. `wordsPerChapter` 最小 1000（低于会被 clamp 到 1000，`schemas.py:117-123`）；`chapters` 默认 50，插件务必显式给小值，否则一次生成 10 万字。
5. `scope=all` 与 `scope=in_work/independent` 走不同 SQL；插件列“我的小说”用默认 `all` 即可。
6. 记录详情 `GET /records/{id}` 可能非常大（`chapterList` 全章），只取元数据时避免对 50 章小说频繁调用。
7. `/api/novel/review`（SSE）会**覆盖**记录里的 `submissionReport`（`novel.py:255-267`），如果插件不想改数据，别调。

---

## 3. 剧本（screenplay）

源码：`backend/api/routes/screenplay.py`（1264 行）；领域模型 `backend/services/screenplay/schemas.py`。
**整个 router 挂了功能权限依赖**：账号 `effective_features()` 里没有 `"screenplay"` 时所有接口 403 `{"detail":"无剧本 Agent 使用权限"}`（`screenplay.py:68-76`）；管理员也走这个检查。

### 3.1 全部 `@router`（`APIRouter(prefix="/api/screenplay")`，`screenplay.py:72-76`）

| 方法 | 路径（含前缀） | 形态 | 说明 | 出处 |
|---|---|---|---|---|
| POST | `/api/screenplay/import` | 同步 multipart | 导入 txt/pdf/doc/docx → `{item:{fileName,extension,size,pageCount,text,detected}}` | 623-636 |
| POST | `/api/screenplay/stream` | **异步 job** | 生成剧本，返回 `{jobId,screenplayId}`（名字带 stream，但**不是 SSE**） | 638-734 |
| GET | `/api/screenplay/records` | 同步 | 分页列表（`page,pageSize≤200,scope,keyword,status,episode,version,summary`） | 735-764 |
| POST | `/api/screenplay/records` | 同步 | 直接以结构化文档创建记录（`ScreenplayCreateRequest`） | 765-771 |
| POST | `/api/screenplay/from-story-graph` | 同步 | 剧情图/反推 payload → 剧本记录 | 772-811 |
| GET | `/api/screenplay/records/{id}` | 同步 | 详情 `{item, linkedDramas}`；`item` 含 `marketText/standardText/scenes/...` | 813-831 |
| GET | `/api/screenplay/records/{id}/export` | 同步下载 | `?format=md\|docx\|pdf`，导出**市场版**（无景别/时长等内部字段） | 834-877 |
| PATCH | `/api/screenplay/records/{id}` | 同步 | 局部更新（`exclude_unset`） | 880-896 |
| DELETE | `/api/screenplay/records/{id}` | 同步 | 删除 | 899-909 |
| GET | `/api/screenplay/{id}/quality` | 同步 | 实时生产门禁报告 `{report:{score,status,issues[],metrics}}` | 912-931 |
| POST | `/api/screenplay/{id}/quality-repair` | **同步（LLM，较慢）** | 按集/问题码返修，`{item,report,changed,attempts}` | 934-979 |
| POST | `/api/screenplay/{id}/to-drama` | 同步（结构转换） | 转短剧项目；可选 `autoProduce/generateAssets` 起后台任务 | 982-1107 |
| POST | `/api/screenplay/{id}/revise-scene` | **同步（LLM）** | 单场改稿 `{item}` | 1110-1135 |
| POST | `/api/screenplay/{id}/to-storyboard` | 同步（结构转换） | 结构化剧本 → 分镜表 `{storyboard}` | 1138-1162 |
| GET | `/api/screenplay/{id}/storyboard` | 同步 | 读取已保存分镜；没有则现生成初稿；`{storyboard,persisted,stale?}` | 1165-1204 |
| PUT | `/api/screenplay/{id}/storyboard` | 同步 | 保存分镜文档（`StoryboardDocument`，`rows` 至少 1 条） | 1207-1239 |
| POST | `/api/screenplay/{id}/from-storyboard` | 同步 | 分镜回写剧本预览 `{item}`（不覆盖原剧本） | 1242-1264 |

### 3.2 生成链路（正确用法）

请求体 `ScreenplayGenerateRequest`（`services/screenplay/schemas.py:351-370`，🧪）：

```jsonc
{
  "sourceType": "idea",        // idea | novel | import
  "idea": "创意",               // sourceType=idea 时必填
  "novelText": "",             // sourceType=novel 且不想传 novelId 时可直接给正文
  "novelId": "",               // sourceType=novel 时优先按 id 从小说库取正文（校验收属）
  "novelTitle": "",
  "importedText": "",          // sourceType=import 时必填（先调 /import 拿 text）
  "importedFileName": "",
  "title": "",
  "genre": "", "style": "",
  "platform": "短视频",
  "episodeCount": 10,          // 1~500
  "durationSeconds": 60,       // 1~86400（全剧/单集预算，取决于模板）
  "targetSceneCount": 0,       // 0~500，0=自动
  "preserveEnding": true,
  "resumeScreenplayId": "",    // 续写/恢复：已存在剧本 id
  "model": "", "apiBaseUrl": "", "apiKey": ""
}
```

响应：`{"jobId":"<JOB_ID>","screenplayId":"<SCREENPLAY_ID>"}`（`screenplay.py:728-734`）。
内部会：先建占位剧本（status=generating）→ 建 job（type=`screenplay_generate`）→ 后台线程跑 LLM（`screenplay.py:419-620`）。

典型流程（插件）：

```bash
# 1) 提交
curl -s -X POST "$BASE/api/screenplay/stream" -H "Authorization: Bearer $TOKEN" \
 -H 'Content-Type: application/json' \
 -d '{"sourceType":"idea","idea":"社畜在电梯里被拉进死亡闯关游戏","episodeCount":3,"durationSeconds":60,"platform":"短视频"}'
# -> {"jobId":"<JOB_ID>","screenplayId":"<SP_ID>"}

# 2) 轮询（job.result.generationView 里已有实时分集进度）
curl -s "$BASE/api/drama/jobs/<JOB_ID>" -H "Authorization: Bearer $TOKEN"

# 3) 完成：job.result 实测形如
# {"screenplayId","screenplayTitle","title","href","sourceType","retryPayload","modelUsage":[],"ownerUserId","billingReservationId","generationView":{...},"generationPartial":{...}}
curl -s "$BASE/api/screenplay/records/<SP_ID>" -H "Authorization: Bearer $TOKEN"
# -> {"item":{"marketText":"...","standardText":"...","scenes":[...],"characters":[...],...},"linkedDramas":[]}
```

- **完整文本拿法**：`GET /api/screenplay/records/{id}` → `item.marketText`（市场版，给人看）和 `item.standardText`（标准版，含制作字段）。两者都在 `store.create_screenplay/update_screenplay` 时生成（`services/screenplay/store.py:479-486`）。
- 生成过程中的 `job.result.generationView.marketText` 也持续累积（真机历史行 ✅：`stage,completed,total,currentEpisode,title,summary,characters,episodePlans,episodes,log,sceneCount,shotCount,characterCount,marketText`）。可做“边生成边预览”，但**最终以记录为准**。
- 续写/中断恢复：`resumeScreenplayId` + 请求体；后台会把 `generationPartial` 合并回草稿（`screenplay.py:405-437,496-517`）。中断任务被取消后剧本状态为 `paused`，可继续。
- 同一剧本正在生成时再次提交 → 409 `该剧本正在生成中`（`screenplay.py:660-666`）。
- job 卡死保护：running 超过 8 分钟无更新会被判“生成中断”，已生成内容保留（`screenplay.py:157-160`、`api/routes/drama.py:7200-7212`）。

### 3.3 从小说转剧本

- 方式 A（推荐）：先有小说记录 id，`POST /api/screenplay/stream` 传 `sourceType:"novel", novelId:"<NOVEL_ID>"`（正文由服务端读，校验 owner，读不到抛 404 `小说不存在`；`screenplay.py:117-154`、`_load_novel_source`）。
- 方式 B：直接把正文塞 `novelText`（避免记录依赖）。
- 方式 C：`POST /api/screenplay/from-story-graph`，把反推 payload / 画布剧情图转剧本记录（同步、无 LLM；`screenplay.py:772-811`）。

### 3.4 剧本转短剧 / 转分镜

**转短剧**（`POST /api/screenplay/{id}/to-drama`，`screenplay.py:982-1107`）：

```jsonc
{
  "title": "",                    // 空则用剧本标题
  "aspectRatio": "9:16",          // 9:16|16:9|1:1
  "autoProduce": false,           // true: 立刻起 autopilot 出片（烧钱/耗时）
  "generateAssets": false,        // true: 起分镜产物 job（身份板/故事板图）
  "videoRenderProvider": "", "videoModel": "", "videoApiBaseUrl": "", "videoApiKey": ""
}
```

响应：`{"project": DramaProject, "jobId": "<首个job或空>", "jobIds": [...]}`（`screenplay.py:1103-1107`）。
这是**同步结构转换**（几乎秒级；日志里专门打了耗时 `screenplay.py:1024-1030`），不会重新调用 LLM。`autoProduce=true` 时若剧本属于系列，会对整个系列起 `batch_autopilot`。

**转分镜**（`POST /api/screenplay/{id}/to-storyboard`，body `{episode?, aspectRatio?}`，`screenplay.py:1138-1162`）：
纯结构转换，返回 `{"storyboard": StoryboardDocument}`；`StoryboardDocument` 字段见 🧪 OpenAPI：
`id, version, type, title, status, aspectRatio, sourceScreenplayId, sourceScreenplayVersion, sourceType, episode, rows[], totalDurationSeconds, conversionNotes, createdAt, updatedAt`。
要把分镜**持久化**需再 `PUT /api/screenplay/{id}/storyboard`（body 就是 `StoryboardDocument`，`rows` 不能空），之后 `GET` 会返回 `{storyboard, persisted:true, stale:bool}`（`stale` 表示剧本版本已更新）。

### 3.5 剧本坑清单

1. **不是 SSE**：`/api/screenplay/stream` 返回 JSON job id；不要按流解析。
2. 整个剧本 Agent 需要 `screenplay` feature；否则 403。
3. `to-drama` 与 `to-storyboard` 是同步转换，适合直接做工具；但 `quality-repair` / `revise-scene` 是**同步 LLM**，可能 1～3 分钟，别用默认 120s 超时。
4. 导出只导出 `marketText`（市场版），不含 internal 制作字段（`screenplay.py:834-877`）。
5. 详情返回 `linkedDramas`，可用于“这个剧本已经转成哪些短剧项目”（`screenplay.py:825-831`）。
6. `from-story-graph` 的 body 结构比较松（`Dict`），优先传 `{payload:{storyGraph:{...}}}` 或 `{project:{...}}`（`screenplay.py:782-792`）。

---

## 4. 短剧（drama）

源码：`backend/api/routes/drama.py`（7411 行）+ `drama_schemas.py`；图编排 `backend/services/drama_graph/stream.py`；后台任务 `services/drama_storyboard_runner.py`、`drama_storyboard_job.py`、`drama_autopilot.py`。
`/api/drama` 下还有 `drama_scenes.py`、`drama_props.py` 两个 router（同前缀），本插件基本不用。

### 4.1 核心端点（“一句话生成短剧/项目/分镜”相关）

| 方法 | 路径 | 形态 | 说明 | 出处 |
|---|---|---|---|---|
| GET | `/api/drama/health` | 公开同步 | 能力/密钥探针（**无需登录**） | drama.py:345-372 |
| POST | `/api/drama/chat/jobs` | **异步 job** | **一句话生成/改写分镜的推荐入口**，立刻返回 `{jobId}` | drama.py:410-422 / runner.py:23-71 |
| POST | `/api/drama/chat/stream` | **真 SSE** | 同上的流式版；事件见 4.4 | drama.py:403-408 |
| POST | `/api/drama/novel/stream` | **真 SSE** | 小说/章节 → 系列多集分镜（逐集串行） | drama.py:424-430 / drama_agent.py:2115 |
| POST | `/api/drama/novel/jobs` | **异步 job** | 同行后台版，返回 `{jobId}` | drama.py:432-445 / runner.py:74-116 |
| POST | `/api/drama/novel/from-file`、`/novel/from-file/jobs` | multipart SSE / job | 上传小说文件改编（字段见 4.3） | drama.py:447-556 |
| GET | `/api/drama/projects` | 同步 | 项目列表 `{"projects":[DramaProject...]}`（`seriesId`/`standalone`/`limit` 过滤） | drama.py:558-579 |
| POST | `/api/drama/projects` | 同步 | 创建空项目，返回 `{"project": DramaProject}` | drama.py:612-633 |
| GET | `/api/drama/project/{id}` | 同步 | 项目详情 `{project, provenance, assetReferences, activeShotJobs, failedShotJobs, activeExportJobs}` | drama.py:4824-4867 |
| PATCH | `/api/drama/project/{id}` | 同步 | 改标题/单集名/项目自有 LLM Key | drama.py:5157（`UpdateProjectMetaRequest`） |
| POST | `/api/drama/project/{id}/shots/{shotId}/generate` | **异步 job** | 单镜出片/关键帧，返回 `{jobId, referencePreflight}` | drama.py:5943-6005 |
| POST | `/api/drama/project/{id}/autopilot` | **异步 job** | 一键成片（定妆+关键帧+出片+配音+压片），返回 `{jobId}` | drama.py:6017-6024 / drama_autopilot.py:293-314 |
| POST | `/api/drama/project/{id}/autopilot/stream` | SSE | 一键成片 SSE 版 | drama.py:6045-6054 |
| POST | `/api/drama/project/{id}/storyboard-artifacts/job` | 异步 job | 反推直写分镜后补身份板/故事板（可接 autoProduce） | drama.py:6027-6043 |
| GET | `/api/drama/jobs/{jobId}` 等 | 同步 / SSE | 见 1.5 | drama.py:7200-7411 |
| GET | `/api/drama/project/{id}/files/{path}`、`/download/mp4`、`/download/srt`、`/download/ass` | 同步下载 | 项目内媒体/成片/字幕（需登录） | drama.py:6476-6572,7092-7115 |
| GET | `/api/drama/project/{id}/production-status`、`/quality-preflight` | 同步 | 制作状态/压片门禁 | drama.py:4801-4824 |
| POST | `/api/drama/project/{id}/compose` | **异步 job** | ffmpeg 压片，返回 `{jobId}`；完成时 `job.result={mp4Path}`、项目 `exportArtifact.mp4Path` 更新 | drama.py:6171-6221 |

### 4.2 最小可用「创建项目 → 生成分镜」调用链

有两种等价写法，**推荐写法 A（少一步）**：`/api/drama/chat/jobs` 不传 `projectId` 时，内部 `create_mode = true`，会自动建项目并把分镜写进项目（`drama_graph/stream.py:443-466,537-564`），完成后从 `job.result.donePayload.projectId` 取 id。

```bash
# A. 一句话生成（自动建项目 + 生成分镜；不自动出片）
curl -s -X POST "$BASE/api/drama/chat/jobs" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "message":"外卖员捡到能看见死亡倒计时的旧手表，第一集结尾必须反转",
        "userRequirement":"竖屏写实短剧，真人电影质感，自然光影；前 3 秒有钩子，结尾卡点",
        "targetDurationSec":60,
        "fastMode":true,
        "originType":"idea"
      }'
# -> {"jobId":"<JOB_ID>"}

# 轮询 job，直到 status=done
curl -s "$BASE/api/drama/jobs/<JOB_ID>" -H "Authorization: Bearer $TOKEN"
# done 时（真机历史行 ✅）：
# {
#   "job": {
#     "type":"storyboard","status":"done","progress":1.0,"message":"分镜已完成",
#     "result":{
#       "autoProduce":false,"phase":"done","seriesId":"","currentAgent":"persist_create",
#       "retryPayload":{...},"modelUsage":[...],"ownerUserId":"...","agentsRun":[...],
#       "projectId":"<PROJECT_ID>",
#       "donePayload":{"projectId":"<PROJECT_ID>","title":"...","multiAgent":true,
#                      "agentsRun":[...],"fastMode":true,"canvasPath":"/project/<PROJECT_ID>/canvas",
#                      "canvasWorkflow":false},
#       "autopilotJobId":""
#     }
#   }
# }

# 取分镜
curl -s "$BASE/api/drama/project/<PROJECT_ID>" -H "Authorization: Bearer $TOKEN"
# -> {"project":{"id","title","status","aspectRatio","shots":[...],"characters":[...],
#                "timeline":{...},"chatHistory":[...],"exportArtifact":{...},...}, ...其它}
```

写法 B（显式先建项目，再在项目内生成/润色）：

```bash
curl -s -X POST "$BASE/api/drama/projects" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"倒计时手表","aspectRatio":"9:16","originType":"idea"}'
# -> {"project":{"id":"<PROJECT_ID>", ...}}

curl -s -X POST "$BASE/api/drama/chat/jobs" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"生成第一集分镜","projectId":"<PROJECT_ID>","fastMode":true}'
```

- `DramaChatRequest` 关键字段（`api/drama_schemas.py:977-1020`，🧪）：
  `message`（★必填）、`projectId`、`shotId`、`selectedNodeId(s)`、`seriesId`、`model/apiBaseUrl/apiKey`、
  `userRequirement`（默认竖屏写实短剧硬约束）、`visualStyle`、`imagePaths[]`、`referenceVideoPath`、
  `autoProduce`、`fastMode`、`targetDurationSec`（0~900，默认 30）、`videoRenderProvider/videoModel/videoApiBaseUrl/videoApiKey`、
  `canvasWorkflow`、`confirmedActions[]`、`originType/sourceId/...`（来源链元数据，只在新建项目写入）。
- **注意**：`autoProduce` 在当前代码里被硬编码为 `false`（`drama_graph/stream.py:444-445`；`runner.py:28-29` 同样写死），**请求里传 true 也不会自动出片**。要出片必须显式调 `POST /api/drama/project/{id}/autopilot`。
- `message` 为空且没有 `projectId` → 400 `message 不能为空`（`drama.py:410-415`）。
- 单镜润色：同接口带 `projectId + shotId + message`；批量改分镜：带 `projectId + message`（走 `refine_project`，`drama_graph/stream.py:302-324`）。
- 项目详情里的分镜结构：`project.shots[]` 每条是 `DramaShot`（🧪 43 个字段），**常用**：
  `id, index, name, dialogue, dialogueLines[], speaker, characterId, scene, plotDesc, visualDesc, shotSize, cameraMove, lighting, durationSec, assets{...}, render{status,taskId,localPath,remoteUrl,error,...}, audio{...}`。
  出片结果：`shot.render.localPath`（如 `shots/xxx.mp4`）、`shot.render.remoteUrl`（厂商临时地址）、`shot.render.status`（`pending|generating|done|error`，定义见 `drama_schemas.py` 的 `ShotRenderStatus`）。
- 单镜出片请求 `ShotGenerateRequest`（🧪）：`generateVideo:true, generateImage:false, generateKeyframes:true, forceExtend:false` + 可选厂商/模型/Key。job 完成时 `job.result = {shotId, localPath, retryPayload, ownerUserId}`（真机 ✅）。

### 4.3 小说/文件改编成短剧

- 文本接口 `POST /api/drama/novel/jobs`（推荐）或 `/novel/stream`（SSE）。
  请求 `DramaNovelRequest`（`drama_schemas.py:1022-1049`，🧪）：
  `requestType:"novel|chapter|file_text"（默认 chapter）、novelText/chapterText/fileText（至少一个，按 requestType 取）、title、seriesId、novelId、model/apiBaseUrl/apiKey、userRequirement、visualStyle、referenceVideoPath、autoProduce（同样被忽略）、fastMode、maxSegments(1~20，默认5)、targetDurationSec(0~900，默认300)、videoRenderProvider/...`
- 文件接口 `POST /api/drama/novel/from-file/jobs`：multipart 字段 `file` + 上述同名 Form 字段（`drama.py:495-556`）；文件解析复用剧本导入器：`.txt/.pdf/.doc/.docx`、≤25MB、≤50 万字（`services/screenplay/importer.py:14-16,228-261`）。
- 输出：每集一个项目；job done 的 `result.donePayload` 为：
  `{projectIds[], projectId, count, seriesId, seriesTitle, multiAgent, storyboardJobId}`（`drama_agent.py:2015-2110`；runner 还会平铺 `projectId/projectIds/seriesId/autopilotJobId`，`runner.py:104-114`）。
- 顺序：按章切段串行生成，进度里带 `[第 i/N 集 · 标题]` 前缀（`drama_agent.py:1933-1952`）。

### 4.4 `POST /api/drama/chat/stream` 的 SSE 事件（真 SSE）

事件名（`services/drama_graph/stream.py:435-642`，📖；前端消费在 drama 页面）：

| event | payload 关键字段 | 说明 |
|---|---|---|
| `job` | `{jobId, type:"storyboard"}` | 仅 create_mode 时，先给任务 id |
| `status` | `{message, multiAgent:true, fastMode, canvasWorkflow}` | 启动 |
| `agent_step` | `{agent, agentLabel, index, total}` | 多 Agent 阶段推进 |
| `progress` | `{message, agent, agentLabel}` | 文本进度（前端日志） |
| `project` | `{project: DramaProject}` | 中途/最终项目快照（可能多次） |
| `heartbeat` | `{type:"heartbeat", elapsedSec, multiAgent}`（同时发 `: heartbeat` 注释） | 3s 无输出时保活 |
| `workflow_stage` | `{...}` | 画布阶段事件（`stage_event(project)`） |
| `assistant` | `{messageId, message, stage, options[]}` | 画布对话的助手回复 |
| `ask_user` | `{...}` | 需要用户确认（画布） |
| `board_confirm` / `board_commands` / `operator_result` | 画布命令/操作结果 | 画布工作流专用 |
| `done` | `{projectId, title, multiAgent, agentsRun[], fastMode, canvasPath, canvasWorkflow, storyboardJobId?, jobId?, autopilotStarted?}` | 结束 |
| `error` | `{message, cancelled?}` | 失败/取消 |

> 插件若不做画布交互，只关心 `done.projectId`，用 `/chat/jobs` 轮询更省事。

### 4.5 出片（可选，非常重）

- 一键成片：`POST /api/drama/project/{id}/autopilot`，body `AutopilotRequest`（🧪）：
  `skipDubbing:false, skipCompose:false, generateCharacterRefs:true, generateSceneRefs:true, generateImages:false, autoFaceSwap:false, requireAssetRefs:"off|warn|block"，characterRefVisualStyle, videoRenderProvider/videoModel/videoApiBaseUrl/videoApiKey`。
  返回 `{jobId}`；同一项目已有 autopilot 时 409。完成时 job `result = {mp4Path, errors[], stage:"done", stageLabel, stageProgress:1.0, keyframeSummary}`（`drama_autopilot.py:975-1012`，📖）。
  成片下载：`GET /api/drama/project/{id}/download/mp4`（读 `project.exportArtifact.mp4Path`，未生成 404）。
- 单镜出片：`POST /api/drama/project/{id}/shots/{shotId}/generate` → job；完成后项目详情的 `shots[].render` 更新。
- 取景/关键帧文件：`/api/drama/project/{id}/files/{path}`（登录）；转给浏览器时拼 `?access_token=`。
- 计费：autopilot 本身不预扣（`billing.py:337-338` 返回空），但它的子步骤（定妆图/关键帧/视频/配音）会分别结算；单镜出片按 `video` 预扣。**对 DSH 工具来说这是最贵、最慢的能力，建议单独工具 + 二次确认。**

### 4.6 短剧坑清单

1. `POST /api/drama/projects` 只是建空项目，**不生成分镜**；生成必须走 `/chat/jobs`、`/novel/jobs` 或 `/storyboard-artifacts/job`。
2. `autoProduce` 在“一句话生成”链路被写死 false，传了没用（`drama_graph/stream.py:444`）。
3. `chat/jobs` 的 job `type` 是 `storyboard`（不是 `drama`），终止/取消走 `/api/drama/jobs/{jobId}/cancel`。
4. 项目详情会顺带做“历史项目归一化/身份板同步/资产引用同步”（`drama.py:4824-4866`），首次打开可能稍慢，但它是幂等的。
5. `GET /api/drama/project/{id}` 默认 `persistNormalized=false`（不写库），`syncIdentityBoards=true`；想避免任何写库副作用可传 `persistNormalized=false`（默认就是）。
6. 分镜“帧/图/配音”相关的接口非常多（`drama.py` 里 198 个 `@router`），插件先只实现“文字分镜 + 可选出片”即可，其余按需再加。

---

## 5. 视频（video）

源码：`backend/api/routes/video.py`；流式/方案 `backend/services/video_stream.py`；单片段 `backend/services/clip_generate.py`。
Router 前缀 `/api`（`video.py:64`），所以路径是 `/api/video/...`。
请求模型：`backend/api/schemas.py`。

这里其实有**三套不同的“视频”**，别混：

| 套件 | 代表端点 | 产出 | 适合 |
|---|---|---|---|
| A. 视频 Agent（文本/小说 → 分镜方案，可选文生视频） | `/api/video/stream`、`/api/video/generate`、`/api/video/render-plan` | `VideoPlan{videos:[VideoSpec]}`，可选每条带 `renderDownloadUrl` | “小说/一句话 → 多条竖屏视频方案” |
| B. 轻量单片段 | `/api/video/clip/*` | 一个或多个 mp4（图生/文生/首尾帧/参考/编辑） | 插件里“给我生成一个 5 秒视频” |
| C. 文件流 | `/api/video/from-file/stream` | 同上 A，但输入是上传文件 | 本地长文本导入 |

### 5.1 A：视频 Agent

| 方法 | 路径 | 形态 | 说明 | 出处 |
|---|---|---|---|---|
| POST | `/api/video/stream` | **真 SSE** | 生成方案；`submitVideoJobs=true` 时**在同一个 SSE 里**继续出片 | video.py:151-153 / video_stream.py:428-637 |
| POST | `/api/video/generate` | **同步 JSON** | `submitVideoJobs=false` 只出方案；true 则同步阻塞出片 | video.py:156-159 / video_stream.py:412-425 |
| POST | `/api/video/render-plan` | **同步 JSON** | 传已有 `videoPlan`，只跑文生视频（可补交出片） | video.py:162-166 / video_stream.py:367-408 |
| POST | `/api/video/from-file/stream` | SSE | multipart：`file` + 一组 Form 字段 | video.py:405-464 |
| GET | `/api/video/health` | 同步（**需登录**） | `{status, ffmpeg, ffmpegPath}` | video.py:116-122 |

请求体 `StreamVideoRequest`（`api/schemas.py:140-177`，🧪）：

```jsonc
{
  "requestType": "one_line",   // one_line|novel|chapter|file_text
  "userRequirement": "硬性要求，必填",   // ★必填
  "oneLineIdea": "",           // requestType=one_line 时真正被当输入的是它
  "novelText": "",             // requestType=novel
  "chapterText": "",           // requestType=chapter
  "fileText": "",              // requestType=file_text
  "preferredDurationSec": 120, // 15~900
  "model": "", "apiBaseUrl": "", "apiKey": "",
  "videoApiKey": "",
  "maxVideos": 6,              // 1~20（长文本会被拆段）
  "submitVideoJobs": false,    // true 才真的出片
  "videoRenderProvider": "seedance",  // seedance|grok|hailuo|jimeng|kling|wan|happyhorse
  "videoModel": "doubao-seedance-2-0-260128",
  "videoApiBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "videoResolution": "768P",
  "videoAspectRatio": "9:16",
  "videoPollMaxSeconds": 1800, // 60~1800
  "videoClipDurationSec": 6,   // 4~30
  "generateAudio": true,
  "outputFormat": "mp4"         // mp4|mov
}
```

> **坑**：`one_line` 模式下源码取的是 `oneLineIdea`（`video_stream.py:93-100`），不是 `userRequirement`；`userRequirement` 只作为验收硬约束，且**不能为空**（`video_stream.py:103-108`）。所以插件调用时必须两个都填。

`POST /api/video/from-file/stream` 的 multipart 字段（`video.py:405-425`，📖）：`file`（必填）、`userRequirement`（必填）、`requestType`、`preferredDurationSec`、`maxVideos`、`submitVideoJobs`（字符串 `"true"/"false"`）、`videoRenderProvider`、`videoModel`、`videoApiBaseUrl`、`videoResolution`、`videoPollMaxSeconds`、`videoClipDurationSec`、`videoAspectRatio`、`model`、`apiBaseUrl`、`apiKey`、`videoApiKey`。

响应：
- 同步 `/api/video/generate`：`{"videoPlan": VideoPlan}`。
- `VideoPlan = {requestType, totalVideos, maxDurationSec:900, videos:[VideoSpec]}`；
  `VideoSpec`（`schemas.py:116-131`）：`title, audience, style, durationSec, summary, shots[], sequences[], userRequirementsChecklist[], renderTaskId, renderDownloadUrl, renderStorageRel, renderRemoteUrl, renderError`；
  `VideoShot`（`schemas.py:90-103`）：`index, durationSec, visual, dialogue, speaker, plotDesc, narration, subtitle, sceneName, sceneDescription`。
- 出片结果字段：`renderTaskId`、`renderDownloadUrl`（= `/api/video/clip/files/...`，公开）、`renderStorageRel`（存储相对路径）、`renderRemoteUrl`（厂商临时，诊断用）、`renderError`。

SSE 事件（`video_stream.py:440-637`，📖）：

| event | payload |
|---|---|
| `status` | `{type,message:"开始生成视频方案"}` |
| `progress` | `{type,message,current?,total?}` |
| `step` | `{type,step:"segment_start"\|"llm_spec"\|"validate_pass"\|"validate_retry", message, current, total, attempt?, segmentPreview?}` |
| `llm_chunk` | `{type,videoIndex,total,attempt,text}`（逐 token） |
| `heartbeat` | `{type,elapsedSec,videoIndex,total,attempt,message}` + `: heartbeat` 注释 |
| `video_partial` | `{type,index,total,requestType,maxDurationSec,video:VideoSpec}` |
| `video_render` | `{type,index,total,taskId,downloadUrl,storageRel,remoteUrl}` 或 `{type,index,total,error}` |
| `done` | `{type,videoPlan,maxDurationSec}` |
| `error` | `{type,message}` |

耗时：LLM 阶段单条数十秒～数分钟；`submitVideoJobs=true` 时每条视频轮询上限 `videoPollMaxSeconds`（默认 1800s），且是**串行**（`video_stream.py:590-626`）。插件用同步接口时务必给足超时，或改用 `maxVideos:1 + videoPollMaxSeconds:600`。

### 5.2 B：轻量单片段 `/api/video/clip/*`

| 方法 | 路径 | 形态 | 说明 | 出处 |
|---|---|---|---|---|
| GET | `/api/video/clip/models` | 同步 | 可用模型/能力表（缓存 300s） | video.py:467-477 |
| GET | `/api/video/clip/templates` | 同步 | 模板列表（`mode`/`provider` 过滤） | video.py:480-482 |
| POST | `/api/video/clip/upload` | 同步 multipart | 上传素材（≤100MB），返回 `{path,mime,size,batchId,filename,kind,dataUrl?,publicUrl}` | video.py:485-495 / clip_generate.py:406-430 |
| POST | `/api/video/clip/upload-batch` | 同步 multipart | 多文件（≤30）→ `{items,count}` | video.py:498-517 |
| POST | `/api/video/clip/generate` | **同步** | 生成 1~4 条并阻塞返回 `{results[],errors[],mode,provider,model,templateId}` | video.py:564-571 / clip_generate.py:1229-1255 |
| POST | `/api/video/clip/generate/stream` | **SSE** | 事件 `status/progress/heartbeat/partial/done/error` | video.py:574-576 / clip_generate.py:1339-1443 |
| POST | `/api/video/clip/generate/async` | **异步 job**（推荐） | 返回 `{jobId}` | video.py:579-588 |
| GET | `/api/video/clip/jobs/{jobId}` | 同步 | `{"job": JobRecord}` | video.py:673-678 |
| POST | `/api/video/clip/jobs/{jobId}/cancel` | 同步 | 取消 | video.py:681-686 |
| POST | `/api/video/clip/extend/async` | 异步 job | 成片续写（抽末帧→图生→拼接；Grok 原生 extension） | video.py:591-602 |
| POST | `/api/video/clip/post-compose` | **同步** | 成片后期：时间轴裁切/删除/追加 + 烧字幕 + 混 BGM（ffmpeg） | video.py:605-615 |
| POST | `/api/video/clip/post-compose/asr` | 同步 | 识别音轨 → 带时间轴字幕 | video.py:618-628 |
| POST | `/api/video/clip/grok/rematerialize` | 同步 | Grok 已出片但下载失败时只重拉落盘 | video.py:631-670 |
| GET | `/api/video/clip/files/{path}` | **公开** | 播放/下载成品；`?download=1` | video.py:520-553 |
| DELETE | `/api/video/clip/files/{path}` | 同步 | 删除 | video.py:556-561 |

`ClipGenerateRequest`（`api/schemas.py:341-389`，🧪）字段很多，插件简化版：

```jsonc
{
  "mode": "t2v",                 // t2v|i2v|flf2v|r2v|v2v
  "provider": "seedance",        // seedance|grok|hailuo|jimeng|kling|wan|happyhorse
  "model": "doubao-seedance-2-0-260128",
  "prompt": "竖屏，写实电影感，外卖员在地铁口停住，低头看手表",
  "negativePrompt": "",
  "aspectRatio": "9:16",
  "resolution": "1080P",
  "durationSec": 5,              // 4~30
  "promptExtend": true,
  "audioMode": "auto",           // auto|origin|mute
  "generateCount": 1,            // 1~10（SSE/同步内部再 clamp 到 4）
  "pollMaxSeconds": 1800,        // 60~1800
  "imageDataUrl": "", "imagePath": "",          // i2v/flf2v 素材（二选一）
  "lastFrameDataUrl": "", "lastFramePath": "",
  "refImageDataUrls": [], "refImagePaths": [],  // r2v
  "videoUrl": "", "videoPath": "",              // v2v 源视频
  "generateAudio": true,
  "outputFormat": "mp4",
  "templateId": "", "clientIds": []
}
```

异步 job 结果（`batch_executor` 结构，image_studio 真机同构 ✅；clip 单项结果字段见 `clip_generate.py:605-625`）：

```jsonc
{"job":{
  "status":"done",
  "result":{
    "items":[
      {"index":0,"clientId":"vid-slot-0","status":"done","progress":1.0,"message":"完成",
       "result":{"taskId":"...","videoUrl":"/api/video/clip/files/video_clips/<hash>/<name>.mp4",
                  "path":"video_clips/<hash>/<name>.mp4","remoteUrl":"https://...（临时）",
                  "mode":"t2v","model":"...","provider":"seedance"},
       "error":""}
    ],
    "total":1,"current":1,
    "results":[ ...同 result... ],
    "errors":[],
    "payload": { ...单项兼容... }
  }
}}
```

### 5.3 视频坑清单

1. **`/api/video/generate` 名字有误导**：默认 `submitVideoJobs=false`，它只生成分镜方案，不出片。
2. `/api/video/stream` 是 SSE；插件若不想解析流，用 `/api/video/generate` 取方案 + `/api/video/render-plan` 出片（两步都同步、都可能很慢）。
3. `one_line` 输入在 `oneLineIdea`；`userRequirement` 必填但只是约束。
4. `maxVideos` 与长文本拆段联动（`video_stream.py:259-264`）；一条 5 万字小说会拆成最多 `maxVideos` 条，每条都串行出片。
5. `videoClipDurationSec` 在 `RenderVideoPlanRequest` 只允许 `6|10`（`schemas.py:196`），而 `StreamVideoRequest` 允许 4~30；传 5 到 render-plan 会 422。
6. 成品 `videoUrl` 在公开前缀下，但 `remoteUrl` 会过期；持久化只用 `path`。
7. `/api/video/clip/files/{path}` 做路径校验（TOS 模式要求 `video_clips/` 前缀，`video.py:529-542`），不要拼目录穿越。
8. 出片默认 `pollMaxSeconds=1800`，单条最多 30 分钟；多镜头/多视频的同步接口很容易撞插件超时。

### 5.4 最终视频 URL / 路径速查

| 走的路线 | 结果字段 | 可直接播放的 URL | 持久化路径 |
|---|---|---|---|
| A 视频 Agent（`/video/generate` 或 `/video/stream` + `submitVideoJobs`） | `videoPlan.videos[i].renderDownloadUrl` / `renderStorageRel` / `renderTaskId` | `renderDownloadUrl`（`/api/video/clip/files/...`，公开） | `renderStorageRel`（`video_clips/...`） |
| B 单片段同步（`/video/clip/generate`） | `results[i].videoUrl` / `path` / `taskId` | `videoUrl` | `path` |
| B 单片段异步（`/video/clip/generate/async` → job） | `job.result.items[i].result.videoUrl` / `path` | `videoUrl` | `path` |
| 短剧单镜（`/drama/project/{id}/shots/{shotId}/generate`） | 项目详情 `shots[i].render.localPath` / `remoteUrl` | `/api/drama/project/{id}/files/{localPath}?access_token=...`（需登录） | `localPath`（`shots/xxx.mp4`） |
| 短剧成片（`/autopilot` 或 `/compose`） | `job.result.mp4Path`；项目 `exportArtifact.mp4Path` | `/api/drama/project/{id}/download/mp4`（需登录） | `exportArtifact.mp4Path` |

> 一律不要把 `remoteUrl`（厂商临时地址）当最终结果；它只用于诊断，会过期。

---

---

## 6. 提示词反推（图片/视频 → 提示词）

源码：`backend/services/video_prompt_reverse.py`、`backend/services/reverse_jobs.py`、`backend/api/routes/video.py`、`backend/api/routes/drama.py`（项目/分镜级）。请求模型 `api/schemas.py:229-335`。

### 6.1 同步接口（推荐给插件）

| 输入 | 方法+路径 | Content-Type | 请求字段 | 响应 |
|---|---|---|---|---|
| 图片 URL / data URL | POST `/api/video/prompt-from-image` | JSON | `PromptFromImageRequest` | `PromptFromImageResponse` |
| 图片文件 | POST `/api/video/prompt-from-image-file` | multipart | `file` + `userHint, model, apiBaseUrl, apiKey` | 同上 |
| 视频 URL | POST `/api/video/prompt-from-video` | JSON | `PromptFromVideoRequest` | `PromptFromVideoResponse` |
| 视频文件 | POST `/api/video/prompt-from-file` | multipart | `file` + `userHint, reverseMode, model, apiBaseUrl, apiKey, maxFrames` | 同上 |

`PromptFromImageRequest`（`schemas.py:316-326`，🧪）：
`imageUrl`（需 `http(s)` 或 `data:image/...`；空/协议不对 → 400）、`userHint`、`model`（字段说明默认 qwen3-vl-plus；**实际走平台 AI 配置**，本机历史反推用的是 `doubao-seed-2-0-pro-260215`）、`apiBaseUrl`、`apiKey`。

`PromptFromImageResponse`（`schemas.py:329-335`，📖）：
```jsonc
{
  "plainTextPrompt": "一段可直接用于文生图的中文提示词",
  "imagePrompt": {                     // 结构化字段，真机历史结果 ✅
    "subject": "...", "style": "...", "lighting": "...", "composition": "...",
    "mood": "...", "colorPalette": "...", "details": "...", "negativeHints": "..."
  },
  "reverseMeta": {"model":"doubao-seed-2-0-pro-260215","source":"image", ...}
}
```

`PromptFromVideoRequest`（`schemas.py:229-261`，🧪）：
```jsonc
{
  "videoUrl": "http(s) 直链或短视频页面链接",   // 同步视频 URL 接口的必填
  "userHint": "",
  "reverseMode": "drama",   // drama=短剧分镜（带对白/剧情/台词） | visual=视觉提示词
  "model": "",
  "apiBaseUrl": "",
  "apiKey": "",
  "asrApiKey": "",          // 仅 ASR_PROVIDER=dashscope 时用；火山 ASR 走环境变量
  "maxFrames": 12           // 3~30（视觉模型建议 ≤12）
}
```

`PromptFromVideoResponse`（`schemas.py:288-306`，📖）：
```jsonc
{
  "plainTextPrompt": "整体视频提示词",
  "videoSpec": {                           // VideoSpec，同 5.1
    "title":"", "durationSec": 0,
    "shots":[{"index":1,"durationSec":5,"visual":"...","dialogue":"...","speaker":"...","plotDesc":"...","shotSize":"...","cameraMove":"...","lighting":"..."}],
    "sequences":[]
  },
  "videoPrompt": {},                       // visual 模式的结构化字段；drama 模式为空
  "productionPackage": {                   // 短剧生产结构（drama 模式重点）
    "characters":[{"name":"","gender":"","appearance":"","outfit":"","identityPrompt":"",
                   "libraryCharacterId":"","identityImagePath":"","shotIndexes":[]}],
    "storyboardPrompt":"", "storyboardAssetId":"", "storyboardImagePath":"",
    "shotPrompts":[{"index":1,"prompt":""}]
  },
  "frameCount": 12,
  "videoDurationSec": 33.4,
  "reverseMeta": {
    "reverseMode":"drama", "hints":[], "videoUnderstand":{"status":"ok|error|..."},
    "asr":{...}, "subtitleOcr":{...}, "dialogueHealed":true,
    "stitchedTranscript":"...", "dialogueHealError":"", ...
  }
}
```

**支持的模式与限制**（📖/🧪）：
- `reverseMode` 只有 `drama` | `visual`；传其它值**静默回落到 `drama`**（`schemas.py:255-261`、`video.py:258-260`、drama 路由归一化 `drama.py:5735-5749`）。drama 会额外做 ASR/字幕 OCR/台词分配/生产包；visual 输出对齐文生视频的结构化提示词。
- `maxFrames` 3~30，默认 12；视觉模型建议 ≤12（`api/drama_limits.py:MAX_VISION_REVERSE_FRAMES=12`）；真实帧采样会按预算自动降帧（`video_prompt_reverse.py:210-216`）。
- 视频来源：http(s) 直链，**也支持抖音等短视频页面链接**（`tools/video_frames.py:286-300`，走 yt-dlp 回退）。
- 大小/时长限制：下载或上传视频 **≤120MB**（`tools/video_frames.py:28,557-562`）；图片上传 **≤20MB**、仅 jpeg/png/webp/gif（`video_prompt_reverse.py:1908-1919,2016-2019`）；反推出的总时长超过 **900 秒**会 400，要求更短视频或降 `maxFrames`（`video_prompt_reverse.py:347-362`）。
- 失败语义：VL JSON 截断/超 token 时 400 或 502，并提示降帧/缩短视频（`video_prompt_reverse.py:1818-1831`）。
- 同步接口还有副作用：反推成功会**写入全局素材库**（`space_library.try_ingest_text`，`video.py:79-113`），失败不影响响应。

### 6.2 异步接口 + job 轮询（长任务/批量）

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| POST | `/api/video/prompt-from-video/async` | `PromptFromVideoRequest`(JSON) | 视频 URL 单条 → `{jobId}` |
| POST | `/api/video/prompt-from-video/batch/async` | `PromptFromVideoBatchRequest`：`videoUrls[1..10]` + `clientIds[]` | → `{jobId,count}` |
| POST | `/api/video/prompt-from-file/async` | multipart `file,...` | 视频文件单条 → `{jobId}` |
| POST | `/api/video/prompt-from-file/batch/async` | multipart `files[]`(1..10) | → `{jobId,count}` |
| POST | `/api/video/prompt-from-image/batch/async` | JSON `{imageUrls[1..10], clientIds[], userHint, model, apiBaseUrl, apiKey}` | 图片 URL 批量 → `{jobId,count}`（**没有图片 URL 单条 async**） |
| POST | `/api/video/prompt-from-image-file/batch/async` | multipart `files[]`(1..10) | 图片文件批量 → `{jobId,count}`（**没有单文件 async**） |
| GET | `/api/video/prompt-reverse/jobs/{jobId}` | — | `{"job": JobRecord}` |
| POST | `/api/video/prompt-reverse/jobs/{jobId}/cancel` | — | 取消 |
| GET/POST/DELETE | `/api/video/prompt-reverse/history[...]` | — | 反推历史（列表/新增/批量/删除），`{items,count}` |

job 轮询返回的 `result`（批次结构，真机一条 `prompt_reverse` 记录 ✅）：

```jsonc
{"job":{
  "type":"prompt_reverse",
  "status":"done",
  "result":{
    "source":"image-file|video-url|video-file|image-url",   // 实际来源
    "ttlSec":3600, "deadlineAt":"ISO8601",
    "ownerUserId":"...",
    "clientIds":["..."],
    "items":[{"index":0,"clientId":"...","status":"done","progress":1.0,"message":"完成",
              "result":{ /* PromptFromImageResponse 或 PromptFromVideoResponse 全量 + sourceMedia */ },
              "error":""}],
    "total":1,"current":1,
    "results":[ /* 各 done 项 result 平铺 */ ],
    "errors":[],
    "payload": { /* 单项兼容 */ }
  }
}}
```

**关键坑（成本/副作用）**：
- **只有视频反推**（`prompt-from-video*`/`-file*`/drama 项目级）在 `reverseMode=drama|visual`（默认 drama）时，成功后会**额外调用文生图**：给每个识别出的角色生成“身份板”，再生成一张故事板总览图，并把角色/图写入角色库与素材库（`services/reverse_jobs.py:380-470` 的 `_materialize_reverse_images`）。这意味着：
  - 耗时更长（每人一张图 + 一张故事板）；
  - 有图片生成成本；
  - 会产生角色库/素材库数据。
- **同步接口不会**做这一步（只 `_ingest_reverse_result` 写素材库）。因此：
  - 插件只要“提示词文本” → 用同步接口；
  - 插件想要“反推后直接得到身份板/故事板图” → 用异步 job（或 drama 项目的 reverse-prompt/async）。
- 单条同步反推没有 async job 的 TTL/轮询兜底（反推 job TTL 1 小时，`services/reverse_jobs.py:23`）；很长的视频请用 async。

### 6.3 短剧项目/分镜级反推（drama 路由）

| 方法 | 路径 | 请求 | 说明 | 出处 |
|---|---|---|---|---|
| POST | `/api/drama/project/{id}/reverse-prompt` | `DramaReversePromptRequest`(JSON) | 项目级同步反推，**不写数据库** | drama.py:5751-5758 |
| POST | `/api/drama/project/{id}/reverse-prompt/async` | 同上 | → `{jobId}` | drama.py:5760-5768 |
| POST | `/api/drama/project/{id}/reverse-prompt-from-file` | multipart `file,userHint,reverseMode,model,apiBaseUrl,apiKey,maxFrames` | 同步 | drama.py:5770-5797 |
| POST | `/api/drama/project/{id}/reverse-prompt-from-file/async` | 同上 | → `{jobId}` | drama.py:5799-5830 |
| POST | `/api/drama/project/{id}/shots/{shotId}/reverse-prompt` | `DramaReversePromptRequest` | 用该分镜**已有视频**反推（优先本地片，否则下载 remote） | drama.py:5832-5845 / video_prompt_reverse.py:1865-1896 |

`DramaReversePromptRequest`（`drama_schemas.py:1526-1537`）：`videoUrl, userHint, reverseMode(默认 "drama"，但类型是 str), model, apiBaseUrl, apiKey, asrApiKey, maxFrames(3~30)`。`_reverse_prompt_req` 会把 reverseMode 归一化到 `drama|visual`（`drama.py:5735-5749`）。
项目级接口额外校验项目存在（404）；分镜级校验项目+分镜存在，并校验视频存在（否则 400 `该分镜没有可用视频`）。
计费：所有含 `/reverse-prompt` 的 drama POST 都按 `reverse` 预扣（`billing.py:328-330`）。

### 6.4 反推端点选择建议

| 场景 | 用哪个 |
|---|---|
| 插件收到图片 URL，要提示词 | `POST /api/video/prompt-from-image`（同步，~10-60s） |
| 插件拿到本地图片文件 | `POST /api/video/prompt-from-image-file`（multipart） |
| 视频 URL，要整体提示词 | `POST /api/video/prompt-from-video`（`reverseMode:"visual"`，`maxFrames:8`） |
| 视频，要逐镜分镜（含台词） | 同上但 `reverseMode:"drama"`（更慢，会跑 ASR/OCR） |
| 视频本地文件 | `POST /api/video/prompt-from-file`（multipart） |
| 视频很长/批量/怕超时 | `.../async` + `GET /api/video/prompt-reverse/jobs/{jobId}` |
| 只要文本、不要图片产物 | **视频**用同步接口（避免 async 视频反推的 `_materialize_reverse_images`）；**图片** async 本来就只出文本，可放心用 |
| 想要反推后直接得到角色身份板+故事板图 | 用 async 接口（省一次手工串接） |

---

## 7. 提示词扩写

`POST /api/prompt/expand`（`backend/api/routes/prompt.py:14-26`）——需登录，**同步**，计费类别 `polish`（`billing.py:320-321`）。

请求 `PromptExpandRequest`（`api/schemas.py:743-749`，🧪）：

```jsonc
{
  "text": "一个女孩雨夜在天台等人",   // ★必填，minLength 1
  "target": "image",                  // image|video
  "styleHint": "写实电影感",           // 可选
  "maxChars": 2000                    // 200~4000，默认 2000
}
```

响应（`services/prompt_expand.py:57-98`，📖）：

```jsonc
{
  "prompt": "改写后的一整段提示词",
  "notes": "",        // 附加说明（如有）
  "target": "image",
  "chars": 128        // len(prompt)
}
```

- 内部用平台 LLM（`llm_from_inputs("", "", "")`），不暴露 `model/apiKey` 覆盖参数。
- 输出被强制去思考过程/代码块/前缀（`prompt_expand.py:28-51`）。
- 错误：空 `text` 400；LLM 失败 500 `{detail: str}`（`prompt.py:23-26`）。
- 耗时：数秒～20 秒；`maxChars` 只影响提示词长度上限，不改变模型时长。

---

## 8. 给 DSH 插件的落地建议

### 8.1 通用（与现有 `lib/va-client.js` 对齐）

- 连接/鉴权：`lib/va-client.js` 已有 `request(path,{method,body,form,timeoutMs})`、`stream(path,{body,timeoutMs})`、token 缓存（`TOKEN_TTL_MS = 6 天`，小于服务端 7 天，安全）。登录用 `POST /api/auth/login`，body 现有实现用 `{username,password}`，服务端同样接受（`identifier` 优先，空则 username）。
- **默认超时要按端点覆写**：现有 `DEFAULT_TIMEOUT_MS = 120_000` 对生成长任务远远不够。建议：
  - 同步 LLM（`prompt/expand`、`screenplay/quality-repair`、`screenplay/revise-scene`、`video/generate` 无出片）：180～600s；
  - 同步反推（图片 60s、视频 300s）；
  - `video/clip/generate`（同步出片）：`pollMaxSeconds + 120s`；
  - `video/render-plan`：`视频条数 × videoPollMaxSeconds + 300s`；
  - 所有 job 轮询型工具：工具级总预算 30～60 分钟，单次 HTTP 10s 足够。
- **优先“JSON 提交 + job 轮询”，SSE 只作可选进度通道**：
  - 小说：`/api/novel/stream` 本来就是 JSON job；
  - 剧本：`/api/screenplay/stream` JSON job；
  - 短剧：`/api/drama/chat/jobs`；
  - 视频：`/api/video/clip/generate/async`；
  - 反推长任务：`/api/video/prompt-from-*/async`。
  这样避免解析四套不同的 SSE 事件 schema。
- 轮询实现：`sleep 1.5~3s` → `GET /api/drama/jobs/{jobId}`（或 `/api/video/clip/jobs/{id}`）→ 看 `status`；`done/error` 终止；总超时后调 `POST cancel`（尽力）并返回“超时但任务可能仍在跑 + jobId/href”。
- 错误处理：
  - `401/403`：`lib/va-client.js` 已有 `AUTH` 重登一次；403 要区分“无 feature”（`detail` 含 `无剧本 Agent 使用权限`）。
  - **`402`**：现有 client 的 `readError` 只保留 `detail`、把状态码包装成 `HTTP`（`lib/va-client.js:36-42,60-72`），拿不到 `body.code`；建议给 client 增加“读取原始 body”的分支，识别 `code === "INSUFFICIENT_POINTS"` 后把 `requiredPoints/availablePoints` 原样回给模型/用户，并提示充值/联系管理员。
  - `409`：小说并发/autopilot 重复；可提示“已有任务在跑，去任务中心看”。
  - `422`：字段/取值错（典型：`render-plan` 的 `videoClipDurationSec` 只接受 6 或 10）。
- 媒体 URL：结果优先返回 `videoUrl`/`renderDownloadUrl`（公开可直接播）+ `path`（服务端相对路径，供后续接口复用）+ 面向用户的 `GET /api/drama/project/{id}/files/...?access_token=` 形态（若需要浏览器直开）。
- 探活：`GET /api/drama/health`（公开，30s 缓存），检查 `aiKeys.video_seedance / vision_doubao / llm_doubao` 等，提前给用户“未配置模型”的明确提示，而不是等 400/500。

### 8.2 每个 DSH 工具的参数精简建议

| 工具 | 最小参数 | 固定/可省参数 | 返回给模型的内容 |
|---|---|---|---|
| `va_novel_generate` | `idea`（必填）、`title`、`chapters`（默认 1）、`wordsPerChapter`（默认 1000）、`workMode`（默认 `short`） | `style/fastMode=true/submissionReview=false/platform=fanqie/storyPattern=general`；`apiKey` 一律不传（用平台配置） | `novelId`、`jobId`、完整正文（`/markdown`）+ 字数；大文本建议先存文件再由工具引用路径 |
| `va_novel_export` | `novelId`、`format` | — | 文件路径/下载 URL |
| `va_screenplay_generate` | `idea` 或 `novelId`、`episodeCount`（默认 3）、`durationSeconds`（默认 60） | `sourceType` 自动推导；`platform=短视频`；`fastMode` 无此字段 | `screenplayId`、`jobId`、`marketText`（全文）、分集数 |
| `va_screenplay_to_drama` | `screenplayId`、`title?`、`aspectRatio` | `autoProduce:false, generateAssets:false`（默认，避免贵操作） | `projectId`、`shots` 摘要 |
| `va_drama_generate` | `message`（一句话剧情）、`targetDurationSec`（默认 60） | `userRequirement` 用默认；`fastMode:true`；`originType:"idea"`；不要传 `autoProduce`（无效） | `projectId`、`jobId`、每镜 `index/plotDesc/dialogue/durationSec`、总时长 |
| `va_drama_refine` | `projectId`、`message`、`shotId?` | `fastMode:true` | 更新后的分镜摘要 |
| `va_drama_produce`（危险/贵） | `projectId`、`skipDubbing/skipCompose` | `generateCharacterRefs:true, generateSceneRefs:true, requireAssetRefs:"warn"` | `mp4` 下载 URL、errors、jobId；**必须二次确认** |
| `va_video_from_text` | `prompt` / `oneLineIdea`、`durationSec`（默认 5） | `mode:"t2v",provider:"seedance",aspectRatio:"9:16",generateCount:1,pollMaxSeconds:600` | `videoUrl`、`path`、taskId |
| `va_video_from_image` | `prompt`、`imagePath`（先用 `/api/video/clip/upload`）或 `imageDataUrl` | `mode:"i2v"`、其余同上 | 同上 |
| `va_video_plan` | `oneLineIdea` 或 `novelText/chapterText`、`userRequirement`、`preferredDurationSec` | `requestType` 由入参推导、`maxVideos` 默认 3、`submitVideoJobs:false` | `videoPlan`（shots 摘要） |
| `va_video_render_plan` | `videoPlan`（来自上一步）、`videoPollMaxSeconds` | `videoRenderProvider` 沿用上一步 | 每条 `renderDownloadUrl` |
| `va_prompt_from_image` | `imageUrl` 或本地 `file` | `userHint`、`model/apiBaseUrl/apiKey` 不传 | `plainTextPrompt`、`imagePrompt` |
| `va_prompt_from_video` | `videoUrl` 或本地 `file`、`reverseMode` | `maxFrames` 默认 8（视觉）/12（drama） | `plainTextPrompt`、`videoSpec.shots`、`productionPackage` |
| `va_prompt_expand` | `text`、`target` | `styleHint`、`maxChars:1000` | `prompt` |

### 8.3 哪些端点不适合直接做“工具原语”，以及替代方案

| 不适合的原因 | 端点 | 替代方案 |
|---|---|---|
| 需要巨大结构化入参（整个 `videoPlan`） | `POST /api/video/render-plan` | 由插件在内部把上一步返回的 `videoPlan` 原样回传；对模型只暴露“渲染第 N 条/全部”的语义参数 |
| 上传大文件（multipart，100MB+） | `POST /api/video/clip/upload(-batch)`、`/prompt-from-*-file`、`/novel/import`、`/screenplay/import`、`/drama/novel/from-file*` | 插件读本机路径 → `FormData`（Node 22 `fetch` 原生支持 `FormData/Blob`，`lib/va-client.js` 的 `form` 参数就是为此留的）。**不要**让模型传 base64；`clip/upload` 返回 `path` 后可反复用于 `imagePath/refImagePaths/sourceVideoPath` |
| 只支持 URL 的上游（本地文件无法直传） | `/prompt-from-image`、`/prompt-from-video` | 本地文件用对应的 `-file` 端点；或先 `POST /api/video/clip/upload` 拿到 `publicUrl` 再走 URL 版（注意 `publicUrl` 免登录） |
| 真 SSE、事件 schema 多 | `/api/video/stream`、`/api/drama/chat/stream`、`/api/drama/novel/stream`、`/api/drama/project/{id}/autopilot/stream` | 用对应的 `/jobs` 版本（`chat/jobs`、`novel/jobs`、`autopilot`）；小说/剧本本来就是 JSON job |
| 浏览器专用（需要 EventSource/画布命令） | `/api/drama/tasks/stream`、`board_*`/`operator_*` 事件 | 用 `GET /api/drama/tasks` 轮询 |
| 会改库/覆盖报告 | `POST /api/novel/review`、`PATCH /api/*/records/{id}`、`PUT /api/screenplay/{id}/storyboard` | 只读工具不要调；需要保存时单独暴露“保存”工具并提示用户 |
| 极贵/极慢（可能几十分钟） | `/autopilot`、`/batch/autopilot`、`/video/render-plan`、`/shot/generate` 批量 | 作为独立工具 + 明确“预计耗时/可能扣积分” + 返回 jobId 让用户自己查；插件轮询设总预算，超时后保留 jobId |
| 需要管理员权限 | `/api/admin/**` | 不做进插件 |

### 8.4 建议的“长短任务”超时/轮询矩阵

| 工具 | HTTP 超时 | 轮询间隔 | 总预算 | 终态判断 |
|---|---|---|---|---|
| novel generate | 建记录 10s；提交 30s | 3s | 120 min（长篇）/15 min（短篇） | `job.status` + `/markdown` 非空 |
| screenplay generate | 提交 30s | 3s | 60 min | `job.status`；`records/{id}.status=="ready"` |
| drama chat/jobs | 提交 30s | 2s | 30 min | `job.status` + `result.projectId` |
| autopilot | 提交 30s | 5s | 120 min | `job.status` + `result.mp4Path` |
| shot generate | 提交 30s | 3s | 20 min/镜 | `job.status` + 项目详情 `render.status=="done"` |
| clip generate async | 提交 30s | 3s | `pollMaxSeconds`+2min | `job.status`；`items[0].status` |
| clip generate sync | `pollMaxSeconds`+120s | — | 同上 | 响应 `results` |
| video generate（仅方案） | 600s | — | — | 响应含 `videoPlan` |
| video render-plan | 条数×1800+300s | — | — | 响应含 `renderDownloadUrl` |
| prompt reverse 同步 | 图片 60s / 视频 300s | — | — | 响应 `plainTextPrompt` |
| prompt reverse async | 提交 30s | 3s | 20 min | `job.status`；`items[].status` |
| prompt expand | 60s | — | — | 响应 `prompt` |

---

## 9. 实测记录（做了什么、看到什么）

| # | 请求 | 结果 | 结论 |
|---|---|---|---|
| 1 | `GET /api/drama/health` | 200，`{"status":"ok","maxVideoSeconds":900,"maxDramaShots":300,"ffmpeg":true,...,"aiKeys":{...}}` | 公开探活可用；能看密钥配置 |
| 2 | `GET /api/config/site` | 200，`{"loginBackgroundVideoUrl":"","loginBackgroundPosterUrl":""}` | 公开站点配置 |
| 3 | `GET /api/health` | **401** `{"detail":"未登录或登录已过期"}` | 该路径不存在，别拿它探活 |
| 4 | `GET /api/video/health` | 401 | 视频健康检查**要登录**（与 `/api/drama/health` 不同） |
| 5 | `POST /api/auth/login`（不存在的账号 + 错误密码） | 401 `{"detail":"账号或密码错误"}` | 登录错误语义确认 |
| 6 | `GET /api/novel/records`、`/api/video/clip/models`、`/api/drama/jobs/xxx`（无 token） | 全 401 | 默认全鉴权 |
| 7 | `GET /api/novel/stream`（POST-only，无 token） | **401（不是 405）** | 鉴权中间件先于路由；405/404 对未登录者不可见 |
| 8 | `GET /api/nonexistent`（无 token） | 401（不是 404） | 同上；排查路径要带真 token |
| 9 | `OPTIONS /api/novel/records`（Origin: localhost:5173） | 200，`access-control-allow-origin: http://localhost:5173`、`allow-credentials: true`、`allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT`、`max-age: 600` | CORS 正常 |
| 10 | `GET /api/video/clip/files/nope.mp4`、`GET /api/image/files/nope.png` | **404**（不是 401） | 成品文件前缀确实公开 |
| 11 | `GET /openapi.json` | 200，533KB，423 个 path | 可离线核对契约；但 SSE 均被声明为 application/json |
| 12 | `GET /docs` | 200 | 文档页公开 |
| 13 | 只读查询 `backend/storage/drama.db` 的 `jobs` 表（按 type 聚合 `updated_at-created_at`） | 见下表 | 任务耗时量级参考 |

🗄️ 本机历史 job 耗时（只读统计，样本少，仅量级）：

| type | n | 中位 | p90 | max |
|---|---:|---:|---:|---:|
| `novel_generate`（≥30s 的真实生成） | 9 | 632s | — | 5016s（约 84 分钟） |
| `screenplay_generate` | 32 | 606s | 1627s | 3876s |
| `storyboard`（一句话生成分镜，含 create_mode） | 26 | 81s | 575s | 690s |
| `shot_generate`（单镜出片） | 13 | 360s | 489s | 537s |
| `image_studio` | 5 | 67s | 109s | 109s |
| `prompt_reverse` | 1 | 25.6s | — | 25.6s |
| `compose`（压片） | 3 | 1.8s | 2.4s | 2.4s |

> 注：很多 `novel_generate` 的 `done` 记录耗时为 0，是历史导入/占位任务（`result.novelId` 为空），不代表真实生成；上表已过滤 ≥30s。
> 失败原因 Top（同库）：`novel_generate` 31 条“已暂停”、`storyboard` 24 条“已取消”、`screenplay_generate` 6 条“已暂停”——**用户/前端主动取消很常见**，插件要区分“用户取消”和“真实失败”（`result.cancelled/paused`，见 `services/task_center.py:397-403`）。

---

## 10. 附录：本插件相关端点总表（方法 / 登录 / 形态）

> 登录列未标注即 **需要**；形态：`同步`=一次 HTTP 即得结果，`job`=先返回 id 再轮询，`SSE`=流式，`下载`=二进制。

| 能力 | 端点 | 登录 | 形态 |
|---|---|---|---|
| 鉴权 | `POST /api/auth/login` | 否 | 同步 |
| | `GET /api/auth/me` | 是 | 同步 |
| 探活 | `GET /api/drama/health` | **否** | 同步 |
| 小说 | `POST /api/novel/stream` | 是 | job |
| | `POST /api/novel/review` | 是 | SSE |
| | `POST /api/novel/import` | 是 | 同步 |
| | `GET/POST /api/novel/records` | 是 | 同步 |
| | `GET/PATCH/DELETE /api/novel/records/{id}` | 是 | 同步 |
| | `GET /api/novel/records/{id}/markdown` | 是 | 同步 |
| | `GET /api/novel/records/{id}/export` | 是 | 下载 |
| | `POST /api/novel/export/word`、`/pdf` | 是 | 下载 |
| | `POST /api/novel/records/import` | 是 | 同步 |
| 剧本 | `POST /api/screenplay/import` | 是（+feature） | 同步 |
| | `POST /api/screenplay/stream` | 是（+feature） | job |
| | `GET/POST /api/screenplay/records` | 是 | 同步 |
| | `GET/PATCH/DELETE /api/screenplay/records/{id}` | 是 | 同步 |
| | `GET /api/screenplay/records/{id}/export` | 是 | 下载 |
| | `POST /api/screenplay/from-story-graph` | 是 | 同步 |
| | `GET /api/screenplay/{id}/quality` | 是 | 同步 |
| | `POST /api/screenplay/{id}/quality-repair` | 是 | 同步（LLM） |
| | `POST /api/screenplay/{id}/to-drama` | 是 | 同步（可选起 job） |
| | `POST /api/screenplay/{id}/revise-scene` | 是 | 同步（LLM） |
| | `POST /api/screenplay/{id}/to-storyboard` | 是 | 同步 |
| | `GET/PUT /api/screenplay/{id}/storyboard` | 是 | 同步 |
| | `POST /api/screenplay/{id}/from-storyboard` | 是 | 同步 |
| 短剧 | `GET /api/drama/health` | 否 | 同步 |
| | `POST /api/drama/chat/stream` | 是 | SSE |
| | `POST /api/drama/chat/jobs` | 是 | job |
| | `POST /api/drama/novel/stream` | 是 | SSE |
| | `POST /api/drama/novel/jobs` | 是 | job |
| | `POST /api/drama/novel/from-file` | 是 | SSE |
| | `POST /api/drama/novel/from-file/jobs` | 是 | job |
| | `GET/POST /api/drama/projects` | 是 | 同步 |
| | `GET/PATCH/DELETE /api/drama/project/{id}` | 是 | 同步 |
| | `POST /api/drama/project/{id}/shots/{shotId}/generate` | 是 | job |
| | `POST /api/drama/project/{id}/autopilot` | 是 | job |
| | `POST /api/drama/project/{id}/autopilot/stream` | 是 | SSE |
| | `POST /api/drama/project/{id}/storyboard-artifacts/job` | 是 | job |
| | `GET /api/drama/project/{id}/files/{path}` | 是 | 下载 |
| | `GET /api/drama/project/{id}/download/mp4` | 是 | 下载 |
| | `GET /api/drama/jobs/{jobId}` | 是 | 同步 |
| | `GET /api/drama/jobs/{jobId}/stream` | 是 | SSE |
| | `POST /api/drama/jobs/{jobId}/cancel` | 是 | 同步 |
| | `POST /api/drama/jobs/{jobId}/retry` | 是 | 同步 |
| | `GET /api/drama/tasks`、`/tasks/stream` | 是 | 同步 / SSE |
| 视频 | `POST /api/video/stream` | 是 | SSE |
| | `POST /api/video/generate` | 是 | 同步 |
| | `POST /api/video/render-plan` | 是 | 同步（慢） |
| | `POST /api/video/from-file/stream` | 是 | SSE |
| | `GET /api/video/health` | 是 | 同步 |
| | `GET /api/video/clip/models`、`/templates` | 是 | 同步 |
| | `POST /api/video/clip/upload`、`/upload-batch` | 是 | 同步 |
| | `POST /api/video/clip/generate` | 是 | 同步 |
| | `POST /api/video/clip/generate/stream` | 是 | SSE |
| | `POST /api/video/clip/generate/async` | 是 | job |
| | `GET /api/video/clip/jobs/{jobId}` | 是 | 同步 |
| | `POST /api/video/clip/jobs/{jobId}/cancel` | 是 | 同步 |
| | `POST /api/video/clip/extend/async` | 是 | job |
| | `POST /api/video/clip/post-compose`、`/post-compose/asr` | 是 | 同步 |
| | `GET/DELETE /api/video/clip/files/{path}` | **否** | 下载 / 同步 |
| 反推 | `POST /api/video/prompt-from-image` | 是 | 同步 |
| | `POST /api/video/prompt-from-image-file` | 是 | 同步 |
| | `POST /api/video/prompt-from-video` | 是 | 同步 |
| | `POST /api/video/prompt-from-file` | 是 | 同步 |
| | `POST /api/video/prompt-from-video/async`、`/batch/async` | 是 | job |
| | `POST /api/video/prompt-from-file/async`、`/batch/async` | 是 | job |
| | `POST /api/video/prompt-from-image/batch/async`、`/prompt-from-image-file/batch/async` | 是 | job |
| | `GET /api/video/prompt-reverse/jobs/{jobId}` | 是 | 同步 |
| | `POST /api/video/prompt-reverse/jobs/{jobId}/cancel` | 是 | 同步 |
| | `GET/POST/DELETE /api/video/prompt-reverse/history[...]` | 是 | 同步 |
| | `POST /api/drama/project/{id}/reverse-prompt` (+`/async`) | 是 | 同步 / job |
| | `POST /api/drama/project/{id}/reverse-prompt-from-file` (+`/async`) | 是 | 同步 / job |
| | `POST /api/drama/project/{id}/shots/{shotId}/reverse-prompt` | 是 | 同步 |
| 扩写 | `POST /api/prompt/expand` | 是 | 同步 |

---

## 11. 未覆盖 / 明确不建议

- 图片生成（`/api/image/generate*`）、数字人（`/api/digital-human/**`）、音频 TTS（`/api/audio/**`）：不在本插件能力清单内，未展开；短剧 autopilot 内部会用到它们。
- 画布（board/operator）类接口、`/api/drama/workspace/**` 资产库 CRUD、`/api/admin/**`：与 DSH 工具无关，未测。
- `/api/screenplay/stream` 的 SSE 回退分支、`/api/novel/stream` 的旧版 SSE 回退：当前运行版本不会走，仅作为兼容说明保留。

## 12. 版本敏感点（升级后端时优先回归）

1. `/api/novel/stream` 是否仍是 JSON job（历史上曾是 SSE）。
2. `/api/screenplay/stream` 是否仍返回 `{jobId,screenplayId}` 而不是 SSE。
3. `drama_graph/stream.py` 里 `auto_produce` 是否仍被写死 false。
4. `jobs.result` 里 `donePayload.projectId` / `items[].result.videoUrl` / `mp4Path` 的字段名。
5. 白名单前缀（`audio/files`、`video/clip/files`、`image/files` 等）是否有增删（影响免登录媒体 URL）。
6. `/api/video/generate` 的 `submitVideoJobs` 语义是否变化。
7. `lib/va-client.js` 的 `TOKEN_TTL_MS` 应保持 ≤ 服务端 7 天。
