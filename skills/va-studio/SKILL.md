---
name: va-studio
description: Use the connected VA Studio backend to generate a short drama, a novel, a screenplay or a video, and to carry a story from idea to shots. Load this skill when the user asks to 生成短剧/写小说/写剧本/出片/把一句话变成短剧, or wants a Chinese short-form story produced end to end.
---

# VA Studio 内容生成

VA Studio 是一个已配置好模型与素材库的本地创作后端。你通过 `va_studio_*` 工具调用它，工具负责鉴权、提交任务、轮询和取回正文。所有生成都会消耗用户真实积分，**只在用户明确要求时调用**。

## 开始之前

1. 如果不确定是否已连接，先调用 `va_studio_status`。它会返回后端地址、账号、可用功能，以及哪些模型已配置。
2. 如果工具报 `[NOT_CONFIGURED]`，不要在对话里索要密码；让用户打开「设置 → 插件 → VA Studio」填写后端地址与账号后重试。
3. 如果健康检查显示没有可用模型（`aiSummary` 为空），先提醒用户在 VA Studio 管理端配置模型密钥，不要盲目提交任务。

## 选择能力

| 用户想要 | 用哪个工具 | 说明 |
|---|---|---|
| 小说正文（章节/字数） | `va_studio_generate_novel` | 先建小说记录再生成，完成后返回完整 Markdown |
| 图片（文生图/图生图） | `va_studio_generate_image` | 传工作区图片路径则走图生图；返回可直接打开的图片 URL |
| 短剧剧本（分集、台词、场次） | `va_studio_generate_screenplay` | 从一句话创意，或用 `novel_id` 从已有小说改编 |
| 短剧项目 + 分镜（镜头表） | `va_studio_generate_drama` | 一句话剧情 → 自动建项目并生成分镜；**不出片** |
| 单条 4–30 秒视频 | `va_studio_generate_video` | 文生视频；传工作区图片路径则图生视频 |
| 把短剧项目做成成片 | `va_studio_produce_video` | 一键成片（定妆/关键帧/视频/配音/压片），**极贵且慢**，必须用户明确同意后传 `confirm=true` |
| 继续等待一个任务 | `va_studio_job` | 生成工具返回 pending 时用它继续轮询并取回结果 |
| 扩写提示词 | `va_studio_expand_prompt` | 用户只有几个词、要变成可生成提示词时 |

## 调用前要问清楚（一次问完，不要问卷式盘问）

- 题材/梗概：用户只给一句话时，基于它合理补全，不要反复追问。
- 篇幅：小说问章数与每章字数；剧本问集数与单集时长；短剧问目标总时长；图片问画幅（竖屏 9:16 / 横屏 16:9 / 方图 1:1）与张数。
- 风格：真人写实、动漫、古装、悬疑等；不明确时沿用用户上下文里的风格。

## 成本与确认规则

- 单次生成是正常操作，用户提出要求即可执行；不要额外要求确认。
- `va_studio_produce_video`（一键成片）耗时数分钟到数十分钟、按镜头计费：必须先向用户说明预计耗时与可能消耗积分，得到明确同意后才能调用，并传 `confirm=true`。
- 同一内容不要重复生成：先看返回值里有没有可复用的 `novelId` / `screenplayId` / `projectId`。用户说“再生成一版”时才重新提交。
- 用户中途取消或任务失败时，不要自动重试昂贵的出片任务；报告 jobId 与失败原因。

## 等待与轮询

- 每个生成工具都有 `wait_seconds`（默认 120，最大 600）。超时后工具返回 `pending: true` 和 `jobId`，这是正常状态，不是失败。
- 继续等待：调用 `va_studio_job`，传 `job_id` 和 `wait_seconds`（建议 120–300）。它会在任务完成时自动取回小说正文、剧本全文或分镜摘要。
- 任务类型：小说/剧本/短剧分镜/出片/prompt_reverse 都走同一套 job。`status` 为 `done` 才算完成；`error`/`cancelled` 要如实报告。
- 小说任务进行中也能取到已生成部分；但工具在 `done` 后才返回完整正文。

## 结果怎么交给用户

1. 长正文（小说、剧本）不要整段刷在对话里。用你的文件工具写入工作区：
   - 小说 → `va-studio/<书名>.md`
   - 剧本 → `va-studio/<剧本名>.md`
   - 分镜 → `va-studio/<项目名>-分镜.md`
   正文取自工具返回的 `markdown` 或 `marketText`；写入后告诉用户文件路径，并附上标题、字数/集数、前几段摘要。
2. 分镜结果按镜头列出：镜号、景别、运镜、时长、画面、台词。用户要修改时，改完再让他确认是否出片。
3. 图片结果给出 `images[].url`（可直接打开/下载）和 `paths`；文生图 1–4 张，图生图参考图最多 9 张。用户要放在文档里时，先下载到工作区再引用本地路径。
4. 视频结果给出 `videoUrl`（可直接播放）和 `path`；不要使用会过期的厂商 `remoteUrl`。
5. 成片完成后给出 `mp4Path` 与 VA Studio 项目下载地址；提醒成片也可以在 VA Studio 网页端打开。

## 错误码与处理

| 错误 | 含义 | 处理 |
|---|---|---|
| `[NOT_CONFIGURED]` | 插件尚未配置 | 引导用户去设置页，不要在对话里要密码 |
| `[AUTH]` | 账号密码/令牌失效 | 提示用户重新登录或更新密码；不要反复重试 |
| `[INSUFFICIENT_POINTS]` | 积分不足 | 报告所需/可用积分，建议充值或联系管理员 |
| `[PERMISSION]` / 403 | 账号无该功能权限（如剧本 Agent） | 说明缺少 `screenplay` 等功能权限 |
| `[CONFLICT]` | 同一资源已有任务在跑 | 提示去 VA Studio 任务中心查看，或换一个任务 |
| `[TIMEOUT]` / `[UNAVAILABLE]` | 后端未启动或网络问题 | 让用户确认 VA Studio 后端在运行（默认 8790 端口） |
| `[VIDEO_FAILED]` | 厂商出片失败 | 报告原因；可改用更短时长或换模型重试 |
| `[CONFIRM_REQUIRED]` | 未确认就调用一键成片 | 先向用户说明成本并取得同意 |

## 边界

- 不把 API Key、密码、令牌写进提示词、文件或对话。
- 不调用管理端接口，不删除用户的记录。
- 不编造生成结果；工具没返回的字段就说没有。
- 用户要英文内容时按用户要求输出；默认中文。
