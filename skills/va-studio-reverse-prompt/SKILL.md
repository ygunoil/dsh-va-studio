---
name: va-studio-reverse-prompt
description: Use the connected VA Studio backend to reverse-engineer a generation prompt from an image or a video (提示词反推), and to expand short prompts into production prompts. Load this skill when the user uploads a reference image or video and asks 提示词、怎么生成、反推、仿这个风格, or gives a few words and wants a full prompt.
---

# 提示词反推与扩写

VA Studio 的视觉模型可以看图/看视频，输出可直接用于文生图/文生视频的提示词；视频还能输出分镜、台词、角色身份板等制作包。所有反推调用都会消耗积分。

## 准备输入

反推工具接受两种输入，二选一：

- `url`：http(s) 直链。适合网络图片、视频链接（支持常见短视频页面链接）。
- `file_path`：**当前会话工作区内的本地文件**。工具只允许读工作区内的普通文件，不能读工作区外的路径。

用户把图片/视频发到对话里时，附件通常在会话附件目录而不是工作区。先把它复制进工作区再反推：

1. 用你的文件/命令工具找到附件真实路径（用户消息里通常带路径）。
2. 复制到工作区，例如 `mkdir -p va-studio/refs && cp <附件路径> va-studio/refs/<文件名>`。
3. 用 `file_path: "va-studio/refs/<文件名>"` 调用反推。
4. 不要把附件内容转成 base64 塞进参数。

限制：图片 ≤20MB（jpeg/png/webp/gif）；视频 ≤120MB；视频反推总时长超过 900 秒会被拒绝，先剪短或降 `max_frames`。

## 选工具

| 输入/目标 | 调用 |
|---|---|
| 图片 → 生图提示词 | `va_studio_reverse_prompt`，`source: "image"` |
| 视频 → 视觉提示词 | `source: "video"`，`reverse_mode: "visual"`（默认），`max_frames: 8` |
| 视频 → 短剧分镜 + 台词 + 制作包 | `source: "video"`，`reverse_mode: "drama"`（更慢，会跑 ASR/字幕识别） |
| 几个词 → 完整提示词 | `va_studio_expand_prompt`，`target: "image"` 或 `"video"` |

如果用户想要“照着这个视频拍短剧”，用 `reverse_mode: "drama"`，并说明反推结果包含逐镜画面、台词、角色与分镜提示词。

## 结果怎么交付

1. 先给一段可直接复制的提示词（`plainTextPrompt`），不要只给结构化字段。
2. 图片：把 `imagePrompt` 的主体/风格/光线/构图/色调/细节/负面提示逐项列出，方便用户微调。
3. 视频：按镜头列 `index / 时长 / 画面 / 台词`，再给整体提示词；`drama` 模式再列角色与每镜提示词。
4. 用户要复用提示词时，写入工作区 `va-studio/prompts/<名称>.md`，包含提示词、结构化字段和来源信息。
5. 用户要“按这个提示词生成”时，转用 `va_studio_generate_video`（或建议在 VA Studio 图片工作台生成），不要声称反推工具会直接出图。

## 提词与风格

- `user_hint` 写用户关注点，例如“英文提示词，强调运镜和光影”“保留人物服装细节”。
- 反推结果是“还原素材”的提示词，不是二创；要二创时在结果基础上按用户要求改写，并说明改了哪里。
- `expand_prompt` 的 `style_hint` 写风格（写实电影感/国漫/赛博朋克），`max_chars` 默认 1000。

## 错误处理

| 错误 | 含义 | 处理 |
|---|---|---|
| `[NOT_CONFIGURED]` | 插件未配置 | 引导去「设置 → 插件 → VA Studio」 |
| `[AUTH]` | 登录失效 | 提示更新密码/令牌 |
| `[FILE_NOT_FOUND]` / `[FILE_OUTSIDE_WORKSPACE]` | 本地路径不对 | 先复制到工作区，用相对路径 |
| `[FILE_TOO_LARGE]` | 文件超限 | 压缩图片、剪短视频 |
| `[INSUFFICIENT_POINTS]` | 积分不足 | 报告所需/可用积分 |
| `[TIMEOUT]` | 视频反推超时 | 降低 `max_frames`、剪短视频，或改用 VA Studio 网页端异步反推 |
| `[INVALID_ARGUMENT]` | 参数不合法 | 按提示修正，最多重试一次 |

## 边界

- 不读取工作区以外的文件，不把本地文件上传到用户未配置的地址。
- 不伪造反推结果；模型返回为空时如实说明并建议换素材。
- 不把密码、令牌写进提示词或文件。
