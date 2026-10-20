# dsh-va-studio-example

`docs/dsh-plugin-guide.md` 配套的最小第三方 DSH 插件示例，**只用于验证**协议与打包，
请勿直接安装到正在使用的 profile（示例里的工具名、设置页签都是占位）。

## 内容

| 文件 | 作用 |
|---|---|
| `package.json` | `main`、`exports["./client"]`、`dsh.bundle.patch`、`dsh.client`、`engines.dsh` |
| `cordis.patch.yml` | bundle 自带的组合层：`insert` 一行，`name` 写包名 |
| `dsh/index.js` | Host 半：`name/inject/Config/apply` + `defineTool` 工具 + `/api` 端点 + 系统提示分节 + 技能提供者 |
| `client.js` | Client 半：单文件 `window.__ModuleLoader__.load`，注册 `settings.plugins.tab` 页签 |
| `skills/va-studio-example/SKILL.md` | 随包分发的技能正文 |
| `verify/check-client.mjs` | 不启动 Harness 的 client bundle 离线校验 |

## 本地验证（不需要安装）

```sh
node docs/example-plugin/verify/check-client.mjs        # client bundle 协议与注册形状
cd docs/example-plugin && npm pack --pack-destination . # 产出 tarball
tar -tzf dsh-va-studio-example-0.0.1.tgz                # 检查包内容
```

## 安装（会写入 profile，谨慎）

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /absolute/path/to/dsh-va-studio-example-0.0.1.tgz
```

安装后由 Plugins 页启用；验证与回滚步骤见 `docs/dsh-plugin-guide.md`。
