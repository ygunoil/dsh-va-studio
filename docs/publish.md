# 发布到 DSH 插件社区（awesome-dsh-plugin）

社区列表：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
收录规则：每个插件一个 YAML（`data/plugins/<owner>__<repo>.yml`），通过一个 PR 提交。

## 现状（2026-10-20）

| 项 | 状态 |
|---|---|
| 本地 git 仓库 | 已初始化，`main` 分支已提交 |
| GitHub 公开仓库 | 待创建：`ygunoil/dsh-va-studio` |
| 仓库 `dsh-plugin` topic | 待添加 |
| GitHub Release `v0.2.0` + tarball | 待创建（`dist/dsh-va-studio-0.2.0.tgz`） |
| npm 发布 | 暂不做（社区不要求；以后可补） |
| 收录 PR | 待仓库创建满 1 天后提交（CI 会检查 `created_at`） |

## 一次性要求（社区 CI 检查）

1. 公开仓库，根 `package.json` 声明 `dsh.bundle`（本仓库已满足），真实可运行代码（已满足）。
2. 仓库创建满 **1 天** 才能提 PR（CI 自动检查）。
3. 仓库添加 topic：`dsh-plugin`。
4. PR 只新增一个文件：`data/plugins/ygunoil__dsh-va-studio.yml`；内容见 `docs/awesome-listing/ygunoil__dsh-va-studio.yml`。
5. 一个 PR 最多 3 条；PR 不要改其它条目。

## 今天要做的（创建仓库与发布物）

登录 GitHub 后可直接运行仓库里的脚本（依次创建仓库、推送、设置 topic、发布 Release）：

```bash
bash scripts/publish-github.sh
```

等价的手工命令：

```bash
cd /Users/mac/Desktop/xxt/dsh-va-studio

# 1. 创建公开仓库并推送 main
gh repo create ygunoil/dsh-va-studio --public --source . --remote origin --push

# 2. 设置描述与 topic
gh repo edit ygunoil/dsh-va-studio \
  --description "DeepSeek Harness plugin for VA Studio: generate short dramas, images, videos, novels and screenplays, and reverse-engineer prompts." \
  --add-topic dsh-plugin

# 3. 创建 GitHub Release，并附上预构建 tarball（listing 里的 tarball 字段指向它）
gh release create v0.2.0 dist/dsh-va-studio-0.2.0.tgz \
  --repo ygunoil/dsh-va-studio \
  --title "v0.2.0" \
  --notes "Adds image generation (text-to-image and image-to-image). Ten VA Studio tools, settings page, and two skills."
```

## 满 1 天后：提交收录 PR

```bash
# 用脚本自动完成 fork / 加文件 / 提 PR（会先检查仓库年龄）
bash scripts/submit-listing.sh
```

手工步骤等价于：

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
git clone https://github.com/<your-user>/awesome-dsh-plugin.git /tmp/awesome-dsh-plugin
cd /tmp/awesome-dsh-plugin
git checkout -b add-ygunoil-dsh-va-studio
cp /Users/mac/Desktop/xxt/dsh-va-studio/docs/awesome-listing/ygunoil__dsh-va-studio.yml \
   data/plugins/ygunoil__dsh-va-studio.yml
git add data/plugins/ygunoil__dsh-va-studio.yml
git commit -m "Add ygunoil/dsh-va-studio"
git push -u origin add-ygunoil-dsh-va-studio
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add ygunoil/dsh-va-studio" \
  --body-file /Users/mac/Desktop/xxt/dsh-va-studio/docs/publish-pr-body.md
```

## PR 文案

见 `docs/publish-pr-body.md`。

## 备注

- 描述里的数字（10 个工具）必须与代码一致；当前 `lib/tools.js` 注册 10 个工具。
- `tarball` 使用钉住 tag 的 URL，避免 `latest/download` 在版本文件名下 404。
- 以后更新版本：先发新 Release，再改 listing YAML 的 `tarball` 并提一个只改自己条目的 PR。
- npm 可选：发布后 `repository` 字段会自动把 npm 包与仓库关联，不需要在 YAML 里写 `npm:`。
