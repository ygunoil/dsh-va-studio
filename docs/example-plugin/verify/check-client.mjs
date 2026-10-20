/**
 * 离线验证 client.js 的加载协议：不启动 Harness，只模拟
 * window.__ModuleLoader__ / document / require 基线，检查：
 *   1. 顶层只做 load 注册；
 *   2. factory(require) 能产出 { inject, apply }；
 *   3. apply(ctx) 真的把页签注册进 settings.plugins.tab（id/order/locale 正确）；
 *   4. 没有抛出、没有在 apply 之外做副作用。
 *
 * 用法：node verify/check-client.mjs
 * 说明：这里验证的是「协议与注册形状」，不是真实 React 渲染。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')
const source = await readFile(clientPath, 'utf8')

const failures = []
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  ok  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. 静态检查：加载协议必须是 __ModuleLoader__.load，且不带 ESM import/export ──
console.log('client.js 静态契约')
ok('调用 window.__ModuleLoader__.load', source.includes('window.__ModuleLoader__.load({'))
ok('没有 ESM import', !/^\s*import\s+/mu.test(source))
ok('没有 ESM export', !/^\s*export\s+/mu.test(source))

// ── 2. 运行时模拟 ───────────────────────────────────────────────────────────
let captured
const styleRecords = []
globalThis.window = {
  __ModuleLoader__: {
    load: definition => {
      captured = definition
    },
  },
}
globalThis.document = {
  createElement: () => ({
    dataset: {},
    textContent: '',
    remove() {
      styleRecords.pop()
    },
  }),
  head: {
    appendChild(element) {
      styleRecords.push(element)
    },
  },
  querySelector: () => null,
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useId: () => 'id',
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
}
const baseline = {
  react: React,
  'react/jsx-runtime': { jsx: React.createElement, jsxs: React.createElement },
}
const requireStub = name => {
  if (!Object.hasOwn(baseline, name)) throw new Error(`require("${name}") is not in the simulated platform table`)
  return baseline[name]
}

vm.runInThisContext(source, { filename: clientPath })

console.log('client.js 运行时契约')
ok('顶层只注册一个 bundle', Boolean(captured))
ok('bundle id 等于包名', captured?.id === 'dsh-va-studio-example', String(captured?.id))
ok('factory 是函数', typeof captured?.factory === 'function')

const mod = captured.factory(requireStub)
ok('factory 返回 { inject, apply }', Array.isArray(mod?.inject) && typeof mod?.apply === 'function')
ok('只注入 slots / locale', JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(mod?.inject))

const registrations = []
const effects = []
const dictionaries = new Map()
const ctx = {
  effect(fn, label) {
    const disposer = fn()
    effects.push({ label, disposer })
    return () => disposer?.()
  },
  locale: {
    // 真实字典形状是每个 namespace 下按语言分表：{ zh: {...}, en: {...} }。
    register: (ns, dict) => {
      dictionaries.set(ns, dict)
      return () => {}
    },
    bind: ns => key => dictionaries.get(ns)?.zh?.[key] ?? dictionaries.get(ns)?.en?.[key] ?? key,
    subscribe: () => () => {},
    getSnapshot: () => ({ revision: 0 }),
  },
  slots: {
    inject: (key, callback) => {
      const disposer = callback()
      return () => disposer?.()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

mod.apply(ctx)

ok('注册了 1 个 slot 条目', registrations.length === 1, String(registrations.length))
const entry = registrations[0]?.options
ok('槽位是 settings.plugins.tab', entry?.name === 'settings.plugins.tab', entry?.name)
ok('id 稳定', entry?.id === 'va-studio-example', entry?.id)
ok('order 是有限数字', Number.isFinite(entry?.order), String(entry?.order))
ok('声明了 locale 命名空间', entry?.locale === 'vaStudioExample', entry?.locale)
ok('label 可调用且返回本地化文案', typeof entry?.label === 'function' && entry.label() === 'VA Studio 示例')
ok('注册了 zh + en 字典', dictionaries.get('vaStudioExample')?.zh && dictionaries.get('vaStudioExample')?.en)
ok('注入了页面 CSS', styleRecords.length === 1 && styleRecords[0].dataset.pluginCss === 'dsh-va-studio-example')
ok('effect 有可释放 disposer', effects.length === 2 && effects.every(item => typeof item.disposer === 'function'))

console.log('')
if (failures.length > 0) {
  console.error(`client.js: ${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('client.js: all checks passed')
}
