/**
 * dsh-va-studio — browser half (single file, no bundler).
 *
 * The package's `exports["./client"]` points at this file; the DSH client module
 * system loads it and calls the registered factory lazily. `require` only exposes
 * the shared platform table (React etc.), so this file must stay dependency-free.
 *
 * It registers one tab under Settings → Plugins where the user configures the
 * VA Studio backend address and credentials. The Host half owns the credential
 * record and exposes three self-registered endpoints under /api/va-studio.*.
 */
window.__ModuleLoader__.load({
  id: 'dsh-va-studio',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'vaStudio'

    const zh = {
      title: 'VA Studio',
      intro: '连接本地或局域网的 VA Studio 后端，让 Agent 直接生成短剧、视频、小说、剧本，并反推图片/视频提示词。',
      baseUrl: '后端地址',
      baseUrlHint: '例如 http://127.0.0.1:8790，不要带 /api 或结尾斜杠。',
      authMode: '登录方式',
      modePassword: '账号密码',
      modeToken: '访问令牌',
      username: '账号或手机号',
      password: '密码',
      token: '访问令牌',
      savedSecret: '已保存，留空表示不修改',
      loading: '正在读取配置…',
      loadFailed: '读取配置失败',
      reload: '重新读取',
      save: '保存并验证',
      saving: '正在验证连接…',
      testing: '正在测试连接…',
      test: '测试连接',
      saved: '已保存，连接验证通过。',
      testOk: '连接正常。',
      configured: '已配置',
      unconfigured: '未配置',
      readOnly: '当前凭据存储为只读，请联系管理员。',
      hint: '保存时会先检查后端健康状态并验证登录。密码/令牌只保存在本机 Host 的凭据存储中，不会进入对话。',
      missingBase: '请填写后端地址。',
      missingUser: '请填写账号。',
      missingSecret: '请填写密码或访问令牌。',
      CONFLICT: '配置已在其他窗口更新，请重新读取后再保存。',
      READ_ONLY: '凭据存储为只读，无法保存。',
      ENDPOINT: '后端地址无效，请检查是否为 http(s) URL。',
      CREDENTIAL: '账号或密码/令牌无效。',
      AUTH: 'VA Studio 登录失败：请检查账号密码或令牌是否过期。',
      TIMEOUT: '连接超时：请确认 VA Studio 后端已启动。',
      UNAVAILABLE: '无法连接 VA Studio：请确认地址和网络。',
      LOAD_FAILED: '无法读取已保存配置，请点击重新读取。',
      UNKNOWN: '操作失败，请稍后重试。',
    }
    const en = {
      title: 'VA Studio',
      intro: 'Connect a local or LAN VA Studio backend so the agent can generate short dramas, videos, novels and screenplays, and reverse-engineer image or video prompts.',
      baseUrl: 'Backend URL',
      baseUrlHint: 'For example http://127.0.0.1:8790. Do not append /api or a trailing slash.',
      authMode: 'Sign-in method',
      modePassword: 'Username and password',
      modeToken: 'Access token',
      username: 'Username or phone',
      password: 'Password',
      token: 'Access token',
      savedSecret: 'Saved — leave blank to keep it',
      loading: 'Reading settings…',
      loadFailed: 'Could not read settings',
      reload: 'Reload',
      save: 'Save and verify',
      saving: 'Verifying connection…',
      testing: 'Testing connection…',
      test: 'Test connection',
      saved: 'Saved. The connection was verified.',
      testOk: 'Connection is healthy.',
      configured: 'Configured',
      unconfigured: 'Not configured',
      readOnly: 'The credential store is read-only.',
      hint: 'Saving checks the backend health endpoint and verifies sign-in. The password or token stays in the local Host credential store and never enters the conversation.',
      missingBase: 'Enter the backend URL.',
      missingUser: 'Enter the username.',
      missingSecret: 'Enter the password or access token.',
      CONFLICT: 'Settings changed in another window. Reload before saving.',
      READ_ONLY: 'The credential store is read-only.',
      ENDPOINT: 'Enter a valid http(s) backend URL.',
      CREDENTIAL: 'The username or secret is invalid.',
      AUTH: 'VA Studio sign-in failed. Check the password or token.',
      TIMEOUT: 'Connection timed out. Make sure the VA Studio backend is running.',
      UNAVAILABLE: 'Could not reach VA Studio. Check the URL and network.',
      LOAD_FAILED: 'Could not read settings. Reload and try again.',
      UNKNOWN: 'The operation failed. Try again later.',
    }

    const css = `
      .vaStudioCard{box-sizing:border-box;max-width:680px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
      .vaStudioTitle{margin:0;font-size:15px;font-weight:600;line-height:1.4}
      .vaStudioIntro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
      .vaStudioBadge{align-self:flex-start;font-size:12px;line-height:1.5;padding:2px 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}
      .vaStudioBadgeOn{color:var(--dsw-alias-state-success-primary,#2e7d32);border-color:currentColor}
      .vaStudioField{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500;line-height:1.5}
      .vaStudioField>span{color:var(--dsw-alias-label-primary)}
      .vaStudioField input,.vaStudioField select{box-sizing:border-box;width:100%;min-width:0;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-weight:400}
      .vaStudioField input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .vaStudioHelp{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .vaStudioActions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:4px}
      .vaStudioPrimary{appearance:none;font:inherit;font-size:13px;line-height:1.5;border:1px solid transparent;border-radius:8px;padding:6px 16px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);cursor:pointer}
      .vaStudioSecondary{appearance:none;font:inherit;font-size:13px;line-height:1.5;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .vaStudioPrimary:disabled,.vaStudioSecondary:disabled{opacity:.4;cursor:default}
      .vaStudioStatus{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
      .vaStudioError{color:var(--dsw-alias-state-error-primary)}
      .vaStudioOk{color:var(--dsw-alias-state-success-primary,#2e7d32)}
      .vaStudioCard :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
      @media (max-width:520px){.vaStudioCard{padding:12px}.vaStudioActions{flex-direction:column;align-items:stretch}.vaStudioActions>*{width:100%}}
    `

    async function callApi(path, init, signal) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
        signal,
      })
      const text = await response.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = {}
      }
      if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`)
        error.code = data.code || 'UNKNOWN'
        throw error
      }
      return data
    }

    function useSettings(t) {
      const [state, setState] = React.useState({ kind: 'loading' })
      const lifetime = React.useRef(null)

      const load = React.useCallback(() => {
        lifetime.current?.abort()
        const controller = new AbortController()
        lifetime.current = controller
        setState({ kind: 'loading' })
        callApi('/api/va-studio.settings', { method: 'GET' }, controller.signal).then(
          data => {
            if (controller.signal.aborted) return
            setState({ kind: 'ready', data })
          },
          error => {
            if (controller.signal.aborted) return
            setState({ kind: 'error', message: t(error.code) || error.message })
          },
        )
      }, [t])

      React.useEffect(() => {
        load()
        return () => lifetime.current?.abort()
      }, [load])

      return [state, load]
    }

    function emptyForm(data) {
      return {
        baseUrl: data?.baseUrl || 'http://127.0.0.1:8790',
        mode: data?.authMode === 'token' ? 'token' : 'password',
        username: data?.username || '',
        password: '',
        token: '',
      }
    }

    function VaStudioSettings({ t }) {
      const [state, reload] = useSettings(t)
      const [form, setForm] = React.useState(emptyForm(undefined))
      const [busy, setBusy] = React.useState('')
      const [feedback, setFeedback] = React.useState(null)

      React.useEffect(() => {
        if (state.kind === 'ready') setForm(emptyForm(state.data))
      }, [state])

      const update = key => event => setForm(current => ({ ...current, [key]: event.target.value }))

      const run = async (kind, operation) => {
        setBusy(kind)
        setFeedback(null)
        try {
          const result = await operation()
          setFeedback({ tone: 'ok', message: kind === 'save' ? t('saved') : t('testOk') })
          if (kind === 'save') {
            setForm(current => ({ ...current, password: '', token: '' }))
            reload()
          }
          return result
        } catch (error) {
          setFeedback({ tone: 'error', message: t(error.code) || error.message || t('UNKNOWN') })
          return undefined
        } finally {
          setBusy('')
        }
      }

      const missing = () => {
        if (!form.baseUrl.trim()) return t('missingBase')
        if (form.mode === 'password' && !form.username.trim()) return t('missingUser')
        const secret = form.mode === 'password' ? form.password : form.token
        const stored = form.mode === 'password' ? state.data?.hasPassword : state.data?.hasToken
        if (!secret.trim() && !stored) return t('missingSecret')
        return ''
      }

      const payload = () => ({
        revision: state.data?.revision ?? 0,
        baseUrl: form.baseUrl.trim(),
        mode: form.mode,
        username: form.username.trim(),
        ...(form.password.trim() ? { password: form.password } : {}),
        ...(form.token.trim() ? { token: form.token } : {}),
      })

      const save = async () => {
        const problem = missing()
        if (problem) {
          setFeedback({ tone: 'error', message: problem })
          return
        }
        await run('save', () =>
          callApi('/api/va-studio.save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload()),
          }),
        )
      }

      const test = async () => {
        const problem = missing()
        if (problem) {
          setFeedback({ tone: 'error', message: problem })
          return
        }
        await run('test', () =>
          callApi('/api/va-studio.test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload()),
          }),
        )
      }

      if (state.kind === 'loading') {
        return h('section', { className: 'vaStudioCard' }, h('p', { className: 'vaStudioStatus', role: 'status' }, t('loading')))
      }
      if (state.kind === 'error') {
        return h(
          'section',
          { className: 'vaStudioCard' },
          h('h2', { className: 'vaStudioTitle' }, t('title')),
          h('p', { className: 'vaStudioStatus vaStudioError', role: 'alert' }, `${t('loadFailed')}: ${state.message}`),
          h('button', { type: 'button', className: 'vaStudioSecondary', onClick: reload }, t('reload')),
        )
      }

      const data = state.data || {}
      const configured = Boolean(data.configured)
      const readOnly = data.writable === false
      return h(
        'section',
        { className: 'vaStudioCard', 'data-testid': 'va-studio-settings' },
        h('h2', { className: 'vaStudioTitle' }, t('title')),
        h('p', { className: 'vaStudioIntro' }, t('intro')),
        h(
          'span',
          { className: configured ? 'vaStudioBadge vaStudioBadgeOn' : 'vaStudioBadge' },
          configured ? t('configured') : t('unconfigured'),
        ),
        h(
          'label',
          { className: 'vaStudioField' },
          h('span', null, t('baseUrl')),
          h('input', {
            type: 'url',
            value: form.baseUrl,
            placeholder: 'http://127.0.0.1:8790',
            onChange: update('baseUrl'),
            disabled: readOnly || Boolean(busy),
            spellCheck: false,
            autoComplete: 'off',
          }),
          h('p', { className: 'vaStudioHelp' }, t('baseUrlHint')),
        ),
        h(
          'label',
          { className: 'vaStudioField' },
          h('span', null, t('authMode')),
          h(
            'select',
            { value: form.mode, onChange: update('mode'), disabled: readOnly || Boolean(busy) },
            h('option', { value: 'password' }, t('modePassword')),
            h('option', { value: 'token' }, t('modeToken')),
          ),
        ),
        form.mode === 'password'
          ? h(
              'label',
              { className: 'vaStudioField' },
              h('span', null, t('username')),
              h('input', {
                type: 'text',
                value: form.username,
                onChange: update('username'),
                disabled: readOnly || Boolean(busy),
                autoComplete: 'username',
                spellCheck: false,
              }),
            )
          : null,
        h(
          'label',
          { className: 'vaStudioField' },
          h('span', null, form.mode === 'password' ? t('password') : t('token')),
          h('input', {
            type: 'password',
            value: form.mode === 'password' ? form.password : form.token,
            placeholder:
              (form.mode === 'password' ? data.hasPassword : data.hasToken) ? t('savedSecret') : '',
            onChange: update(form.mode === 'password' ? 'password' : 'token'),
            disabled: readOnly || Boolean(busy),
            autoComplete: 'new-password',
            spellCheck: false,
          }),
        ),
        h(
          'div',
          { className: 'vaStudioActions' },
          h('button', { type: 'button', className: 'vaStudioPrimary', onClick: save, disabled: readOnly || Boolean(busy) }, busy === 'save' ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'vaStudioSecondary', onClick: test, disabled: readOnly || Boolean(busy) }, busy === 'test' ? t('testing') : t('test')),
          h('button', { type: 'button', className: 'vaStudioSecondary', onClick: reload, disabled: Boolean(busy) }, t('reload')),
        ),
        feedback
          ? h('p', { className: feedback.tone === 'error' ? 'vaStudioStatus vaStudioError' : 'vaStudioStatus vaStudioOk', role: feedback.tone === 'error' ? 'alert' : 'status' }, feedback.message)
          : null,
        readOnly ? h('p', { className: 'vaStudioStatus vaStudioError' }, t('readOnly')) : null,
        h('p', { className: 'vaStudioHelp' }, t('hint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'va-studio: locale')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.pluginCss = 'dsh-va-studio'
          style.textContent = css
          document.head.appendChild(style)
          return () => style.remove()
        }, 'va-studio: styles')
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'va-studio',
              order: 120,
              locale: NS,
              label: () => t('title'),
            },
            VaStudioSettings,
          ),
        )
        // Third-party bundles are also configurable from their own page under
        // Plugins; the same card renders there as a page instead of a summary.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: 'dsh-va-studio#dsh-va-studio',
              locale: NS,
            },
            ({ t: tabT, view }) => (view === 'summary' ? h('span', null, tabT('title')) : h(VaStudioSettings, { t: tabT })),
          ),
        )
      },
    }
  },
})
