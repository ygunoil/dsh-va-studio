/**
 * dsh-va-studio-example — 浏览器（Client）半，单文件、无构建工具。
 *
 * 协议：package.json 的 exports["./client"] 指向本文件，dsh-client-modules 会把它
 * 作为该包的 client bundle 提供给页面；文件顶层只注册工厂，副作用在 factory 内。
 * `require` 只能拿静态平台模块表里的模块（react 等），其余请求会抛错。
 *
 * 本文件演示：
 *   - 向 Settings → 内置插件 注册一个页签（slot: settings.plugins.tab）；
 *   - ctx.locale.register / bind 的中英文字典；
 *   - ctx.effect 注入幂等 CSS；
 *   - fetch('/api/...') 调用 Host 半自注册的端点。
 */
window.__ModuleLoader__.load({
  id: 'dsh-va-studio-example',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'vaStudioExample'

    const zh = {
      title: 'VA Studio 示例',
      intro: '这个页签由第三方插件注册，用于验证插件加载与自注册端点。',
      loading: '正在读取插件状态…',
      ready: '插件已加载',
      plugin: '插件',
      version: '版本',
      greeting: '问候语',
      reload: '重新读取',
      failed: '无法读取 /api/va-studio-example.status：',
      hint: '端点由插件 Host 半通过 ctx.connection.fetch.register 注册，路径必须位于 /api/ 之下。',
    }
    const en = {
      title: 'VA Studio example',
      intro: 'This tab is registered by a third-party plugin to verify loading and its self-registered endpoint.',
      loading: 'Reading plugin status…',
      ready: 'Plugin loaded',
      plugin: 'Plugin',
      version: 'Version',
      greeting: 'Greeting',
      reload: 'Reload',
      failed: 'Could not read /api/va-studio-example.status: ',
      hint: 'The endpoint is registered by the plugin Host half through ctx.connection.fetch.register; its path must live below /api/.',
    }

    // 只使用自有前缀与主题变量；不写死颜色，避免破坏深浅主题。
    const css = `
      .vaStudioCard{max-width:640px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}
      .vaStudioTitle{margin:0;font-size:15px;font-weight:600;line-height:1.4}
      .vaStudioIntro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .vaStudioRow{display:flex;gap:8px;font-size:13px;line-height:1.5}
      .vaStudioKey{color:var(--dsw-alias-label-tertiary);min-width:72px}
      .vaStudioVal{font-family:var(--dsh-font-family-mono,monospace);overflow-wrap:anywhere}
      .vaStudioStatus{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .vaStudioError{color:var(--dsw-alias-state-error-primary)}
      .vaStudioButton{appearance:none;font:inherit;font-size:13px;line-height:1.5;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;align-self:flex-start}
      .vaStudioButton:disabled{opacity:.4;cursor:default}
      .vaStudioCard :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
    `

    /** 从 Host 半自注册的 GET 端点读取状态；带取消、错误分类和重试。 */
    function useStatus() {
      const [state, setState] = React.useState({ kind: 'loading' })
      const lifetime = React.useRef(null)
      const load = React.useCallback(() => {
        lifetime.current?.abort()
        const controller = new AbortController()
        lifetime.current = controller
        setState({ kind: 'loading' })
        ;(async () => {
          try {
            const response = await fetch('/api/va-studio-example.status', {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(String(response.status))
            const data = await response.json()
            if (!controller.signal.aborted) setState({ kind: 'ready', data })
          } catch (error) {
            if (!controller.signal.aborted) setState({ kind: 'error', message: String(error?.message ?? error) })
          }
        })()
      }, [])
      React.useEffect(() => {
        load()
        return () => lifetime.current?.abort()
      }, [load])
      return [state, load]
    }

    function VaStudioCard({ t }) {
      const [state, reload] = useStatus()
      const rows = state.kind === 'ready'
        ? [
            [t('plugin'), state.data?.plugin],
            [t('version'), state.data?.version],
            [t('greeting'), state.data?.greeting],
          ]
        : []
      return h(
        'section',
        { className: 'vaStudioCard', 'data-testid': 'va-studio-example-card' },
        h('h2', { className: 'vaStudioTitle' }, t('title')),
        h('p', { className: 'vaStudioIntro' }, t('intro')),
        state.kind === 'loading' &&
          h('p', { className: 'vaStudioStatus', role: 'status' }, t('loading')),
        state.kind === 'error' &&
          h('p', { className: 'vaStudioStatus vaStudioError', role: 'alert' }, t('failed') + state.message),
        state.kind === 'ready' &&
          h(
            'div',
            { role: 'group', 'aria-label': t('ready') },
            ...rows.map(([key, value]) =>
              h(
                'div',
                { className: 'vaStudioRow', key },
                h('span', { className: 'vaStudioKey' }, key),
                h('span', { className: 'vaStudioVal' }, String(value ?? '')),
              ),
            ),
          ),
        state.kind !== 'loading' &&
          h('button', { type: 'button', className: 'vaStudioButton', onClick: reload }, t('reload')),
        h('p', { className: 'vaStudioStatus' }, t('hint')),
      )
    }

    return {
      // 只依赖 slots 与 locale；不注入 uiConversation，设置页不需要会话上下文。
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'va-studio-example: locale')
        const t = ctx.locale.bind(NS)

        ctx.effect(
          () => {
            const style = document.createElement('style')
            style.dataset.pluginCss = 'dsh-va-studio-example'
            style.textContent = css
            document.head.appendChild(style)
            return () => style.remove()
          },
          'va-studio-example: styles',
        )

        // 页签容器由 @deepseek-ai/dsh-client-ui-settings-plugins 声明；
        // 用 slots.inject 等待声明出现（插件加载顺序不确定）。
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'va-studio-example',
              order: 100,
              locale: NS,
              label: () => t('title'),
            },
            VaStudioCard,
          ),
        )
      },
    }
  },
})
