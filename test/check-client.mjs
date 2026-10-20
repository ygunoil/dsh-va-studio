/**
 * Offline check of the browser half: simulate the DSH module loader, the shared
 * module baseline, the slot/locale/effect services, then execute the factory and
 * apply(). It proves the bundle registers the VA Studio settings tab without any
 * Harness process.
 *
 * Usage: node test/check-client.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = await readFile(join(root, 'client', 'client.js'), 'utf8')

const failures = []
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  ok  ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('client bundle static contract')
ok('uses window.__ModuleLoader__.load({', source.includes('window.__ModuleLoader__.load({'))
ok('has no ESM import', !/^\s*import\s+/mu.test(source))
ok('has no ESM export', !/^\s*export\s+/mu.test(source))
ok('registers with the package name', source.includes(`id: '${manifest.name}'`))
ok('registers the settings tab slot', source.includes("'settings.plugins.tab'"))
ok('no JSX', !/<[A-Z][A-Za-z]*[\s/>]/u.test(source))

let captured
const styles = []
const registrations = []
const locales = {}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useId: () => 'id',
}
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
const documentStub = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: element => styles.push(element) },
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  URL,
  AbortController,
  fetch: () => {
    throw new Error('fetch must not run during apply')
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client/client.js' })

ok('captured one module entry', Boolean(captured))
ok('entry id matches package name', captured?.id === manifest.name)
ok('entry id is a valid kebab-case name', /^[a-z0-9][a-z0-9._-]*$/u.test(captured?.id || ''))

const factory = captured?.factory
const exported = factory(name => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require(${name})`)
})

ok('factory returns inject + apply', Array.isArray(exported?.inject) && typeof exported?.apply === 'function')
ok('injects slots and locale', exported.inject.includes('slots') && exported.inject.includes('locale'))

const disposers = []
const ctx = {
  effect(fn, label) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push({ label, dispose })
    return () => {}
  },
  locale: {
    register(ns, dictionaries) {
      locales[ns] = dictionaries
      return () => {}
    },
    bind(ns) {
      return key => locales[ns]?.zh?.[key] ?? key
    },
  },
  slots: {
    inject(name, register) {
      if (['settings.plugins.tab', 'plugins.row.config'].includes(name)) register()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  },
}

exported.apply(ctx)

ok('registers settings tab and bundle row config', registrations.length === 2)
const tab = registrations.find(item => item.spec.name === 'settings.plugins.tab')
const row = registrations.find(item => item.spec.name === 'plugins.row.config')
ok('settings tab exists', Boolean(tab))
ok('bundle row config exists', Boolean(row))
const { spec, component } = tab
ok('slot name is settings.plugins.tab', spec.name === 'settings.plugins.tab')
ok('tab id is va-studio', spec.id === 'va-studio')
ok('tab has a numeric order', Number.isFinite(spec.order))
ok('tab has a locale namespace', spec.locale === 'vaStudio')
ok('tab label resolves from locale', spec.label() === 'VA Studio')
ok('component is a function', typeof component === 'function')
ok('row key targets this bundle row', row?.spec.key === 'dsh-va-studio#dsh-va-studio')
ok('row summary renders a node', typeof row.component({ t: key => key, view: 'summary' }) === 'object')
ok('registers zh and en dictionaries', Boolean(locales.vaStudio?.zh && locales.vaStudio?.en))
ok('locales carry save/test copy', Boolean(locales.vaStudio.zh.save && locales.vaStudio.en.save))
ok('injects exactly one stylesheet', styles.length === 1)
ok('stylesheet is marked as plugin css', Boolean(styles[0]?.dataset?.pluginCss))
ok('stylesheet has a disposer', disposers.length >= 1)

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall client checks passed')
process.exitCode = failures.length ? 1 : 0
