/**
 * Client-half activation tests for dsh-plugin-translate-flow.
 *
 * The host suite covers `lib/index.js`; the manifest suite covers the identifiers
 * the three faces share. Neither one ever runs the browser half's `apply`, so a
 * throw inside activation — which registers nothing and therefore leaves the
 * plugin visible in the plugin list with no sidebar entry — would ship unnoticed.
 *
 * This suite loads the real client bundle from `lib/client.js` and runs `apply`
 * against a fake client context that records every slot registration. It asserts
 * that activation succeeds and that it registers exactly the four entries the
 * two pages need:
 *
 *   - `main`, keyed by `translate-flow`
 *   - `sidebar.panellist`, id `translate-flow`
 *   - `main`, keyed by `translate-flow-config`
 *   - `sidebar.panellist`, id `translate-flow-config`
 *
 * Run: node test/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
let failures = 0

/** Assert a condition, recording the result. */
function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}`)
  }
}

/** Assert deep equality on JSON-serializable values. */
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} (got ${JSON.stringify(actual)})`)
}

/** Install the minimal browser globals `apply` touches. */
function installBrowserStubs() {
  const styles = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    head: { appendChild: (node) => styles.push(node) },
  }
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
}

/** Load the real client bundle and return its exports. */
async function loadClient() {
  installBrowserStubs()
  const reactStub = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  await import(`../lib/client.js?client-test=${Date.now()}`)
  ok(captured !== undefined, 'the client bundle registers a factory')
  return captured.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
}

/** Build a fake client context recording slot registrations. */
function makeClientContext() {
  const registrations = []
  const mounted = []
  const calls = []
  const disposed = []
  const ctx = {
    registrations,
    mounted,
    calls,
    disposed,
    // The plugin reaches its own Remote namespace through `ctx.get`, because the
    // namespace is mounted by this same plugin and so cannot be an injected
    // dependency. Serving it here is what makes the calls below real instead of
    // decorative — and every answer is the gateway's `{ ok, value }` envelope,
    // which is the shape the browser half must unwrap.
    get(key) {
      if (key === "remote.translateFlow") return ctx.remote.translateFlow
      return undefined
    },
    remote: {
      async $mount(contribution) {
        mounted.push(contribution)
        return () => disposed.push('remote')
      },
      translateFlow: {
        describe: async () => {
          calls.push('describe')
          return {
            ok: true,
            value: {
              modules: [{ id: 'en2zh', name: '英译中', from: 'English', to: 'Chinese', prompt: 'Translate into Chinese.' }],
              precisionFlow: ['en2zh', 'zh-academic', 'zh2en'],
              allowedRunKeys: ['runId', 'moduleId', 'prompt', 'input', 'provider', 'model'],
              limits: { maxInputChars: 200000, maxPromptChars: 20000, timeoutMs: 300000 },
            },
          }
        },
        listRoutes: async () => {
          calls.push('listRoutes')
          return {
            ok: true,
            value: { providers: [{ id: 'alpha', name: 'Alpha', models: [], status: 'ok' }], current: null },
          }
        },
        runModule: async () => {
          calls.push('runModule')
          return { ok: true, value: { output: '' } }
        },
        cancelRun: async () => {
          calls.push('cancelRun')
          return { ok: true, value: { cancelled: false } }
        },
      },
    },
    slots: {
      inject(key, callback) {
        void key
        return callback()
      },
      register(options, component) {
        registrations.push({ ...options, component })
        return () => disposed.push(options.id ?? options.key ?? 'slot')
      },
    },
  }
  return ctx
}

let captured
const client = await loadClient()

console.log('\nactivation')
eq(client.inject, ['remote', 'slots'], 'the client declares its injected services')
const ctx = makeClientContext()
const dispose = await client.apply(ctx)
ok(typeof dispose === 'function', 'apply resolves and returns a disposer')
ok(
  ctx.mounted[0].descriptors.every((descriptor) => descriptor.result.mode === 'strict'),
  'every mounted descriptor carries a strict result codec',
)

// Let the roster and route queries settle, then check that the namespace the
// plugin resolved through `ctx.get` actually served them: without this the fake
// Remote could be dead code that no assertion notices.
await new Promise((resolve) => setTimeout(resolve, 0))
ok(ctx.calls.includes('describe'), 'the host module roster is requested through the mounted namespace')
ok(ctx.calls.includes('listRoutes'), 'the provider roster is requested through the same namespace')

console.log('\nremote mount')
eq(ctx.mounted.length, 1, 'exactly one Remote contribution was mounted')
eq(ctx.mounted[0].package, 'dsh-plugin-translate-flow', 'the contribution is owned by the package')
eq(ctx.mounted[0].descriptors.length, 4, 'the contribution declares four descriptors')

console.log('\nslot registrations')
const mainPanels = ctx.registrations.filter((entry) => entry.name === 'main')
const sideIcons = ctx.registrations.filter((entry) => entry.name === 'sidebar.panellist')
const panel = mainPanels.find((entry) => entry.key === 'translate-flow')
const icon = sideIcons.find((entry) => entry.id === 'translate-flow')
const configPanel = mainPanels.find((entry) => entry.key === 'translate-flow-config')
const configIcon = sideIcons.find((entry) => entry.id === 'translate-flow-config')
ok(panel !== undefined, 'a main panel is registered')
ok(icon !== undefined, 'a sidebar.panellist entry is registered')
if (panel !== undefined) {
  eq(panel.key, 'translate-flow', 'the main panel uses the flow key')
  ok(typeof panel.component === 'function', 'the main panel is given a component function')
}
if (icon !== undefined) {
  eq(icon.id, 'translate-flow', 'the sidebar entry uses the flow id')
  eq(icon.order, 30, 'the sidebar entry declares its order')
  ok(typeof icon.label === 'function', 'the sidebar label is a locale-aware thunk')
}
ok(configPanel !== undefined, 'a second main panel is registered for configuration')
if (configPanel !== undefined) {
  eq(configPanel.key, 'translate-flow-config', 'the configuration panel uses its own key')
  ok(typeof configPanel.component === 'function', 'the configuration panel is given a component function')
}
ok(configIcon !== undefined, 'a second sidebar entry is registered for configuration')
if (configIcon !== undefined) {
  eq(configIcon.id, 'translate-flow-config', 'the configuration entry uses its own id')
  eq(configIcon.order, 31, 'the configuration entry sits after the flow entry')
  ok(typeof configIcon.label === 'function', 'the configuration label is a locale-aware thunk')
}
const ids = ctx.registrations.map((entry) => (entry.key ?? entry.id))
eq(
  ids,
  ['translate-flow', 'translate-flow', 'translate-flow-config', 'translate-flow-config'],
  'each page and its sidebar entry share one id',
)
const mounted = ctx.registrations.filter((entry) => entry.name === 'main' || entry.name === 'sidebar.panellist')
eq(mounted.length, 4, 'exactly four slots are registered (two pages, two entries)')

console.log('\nmodule/output pair is atomic')
{
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  const dropSlots = source.match(/h\(DropSlot/g) ?? []
  eq(dropSlots.length, 3, 'exactly three drop targets remain (input, output, empty chain)')
  const moduleStart = source.lastIndexOf('if (node.kind === "module")')
  const outputStart = source.indexOf('// output node', moduleStart)
  ok(moduleStart >= 0 && outputStart > moduleStart, 'the module and output branches are locatable')
  const moduleBranch = source.slice(moduleStart, outputStart)
  ok(!moduleBranch.includes('DropSlot'), 'no drop target sits between a module and its own output')
  ok(moduleBranch.includes('flow.prompt'), 'the module branch still renders its prompt editor')
}

console.log('\npage render')
{
  // A second load of the same bundle, this time with a React stand-in that
  // produces inspectable elements, so each page's render body actually runs.
  // Without this, a typo inside either page ships as a panel that mounts and
  // then throws on first paint.
  const renderReact = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
  const walk = (node, text) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, text)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      text.push(String(node))
      return
    }
    if (typeof node.type === 'function') {
      walk(node.type({ ...node.props }), text)
      return
    }
    if (node.props) walk(node.props.children, text)
  }

  let definition
  installBrowserStubs()
  globalThis.window.__ModuleLoader__ = { load: (value) => { definition = value } }
  await import(`../lib/client.js?render-test=${Date.now()}`)
  const renderClient = definition.factory((specifier) => {
    if (specifier === 'react') return renderReact
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  const renderCtx = makeClientContext()
  const disposeRender = await renderClient.apply(renderCtx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  const panels = renderCtx.registrations.filter((entry) => entry.name === 'main')
  eq(panels.length, 2, 'both pages are registered as renderable main panels')
  for (const registered of panels) {
    const text = []
    let failure = null
    try {
      walk(registered.component({}), text)
    } catch (error) {
      failure = error
    }
    ok(failure === null, `the "${registered.key}" page renders without throwing${failure ? ` (${failure.message})` : ''}`)
    ok(text.length > 3, `the "${registered.key}" page renders content`)
  }
  disposeRender()
  ok(renderCtx.disposed.length >= 5, `the render pass releases every registration (released ${renderCtx.disposed.length})`)
}

console.log('\nreader and editor invariants')
{
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  ok(!source.includes('splice(index, 2)'), 'no editor splices a blind two-node window')
  ok(source.includes('node.sourceModuleId === module.id'), 'removal locates the output by identity, not by adjacency')
  ok(source.includes('readOnly: running === true'), 'the source box is locked while a flow runs')
  ok(
    source.includes('customModules.length >= MAX_CUSTOM_MODULES'),
    'the custom-module cap is enforced on write as well as on read',
  )
  ok(source.includes('window.clearTimeout(copyTimer.current)'), 'the copy timer is cleared before it is replaced')
  ok(source.includes('"aria-live": "polite"'), 'run outcomes are announced to assistive technology')
  ok(source.includes('color-mix(in srgb, var(--dsw-alias-bg-base)'), 'the modal scrim uses a theme token, not a literal colour')
}

console.log('\ngraph repair')
{
  // The reader's repair pass decides whether a hand-edited or imported document
  // survives at all, and it is pure. Lifting it out of the bundle lets the edge
  // cases be executed instead of grepped for.
  const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) return ''
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, i + 1)
      }
    }
    return ''
  }
  const lifted = ['repairGraph', 'splitBlocks', 'flattenBlocks'].map(extract)
  eq(lifted.filter((text) => text.length > 0).length, 3, 'the three graph helpers are locatable in the bundle')

  let counter = 0
  const uid = (prefix) => `${prefix}-${(counter += 1)}`
  const build = new Function('uid', `${lifted.join('\n')}\nreturn { repairGraph, splitBlocks, flattenBlocks }`)
  const { repairGraph, splitBlocks, flattenBlocks } = build(uid)

  const input = { id: 'i1', kind: 'input', text: 'hello' }
  const modA = { id: 'mA', kind: 'module', defId: 'en2zh', name: 'A', prompt: 'p', route: null }
  const modB = { id: 'mB', kind: 'module', defId: 'zh2en', name: 'B', prompt: 'q', route: null }
  const outA = { id: 'oA', kind: 'output', sourceModuleId: 'mA', text: '' }
  const outB = { id: 'oB', kind: 'output', sourceModuleId: 'mB', text: '' }
  const ids = (nodes) => nodes.map((node) => node.id)

  eq(ids(repairGraph([input, modA, outA, modB, outB])), ['i1', 'mA', 'oA', 'mB', 'oB'], 'a well-formed chain is preserved node for node')
  eq(ids(repairGraph([input, modA, modB, outB, outA])), ['i1', 'mA', 'oA', 'mB', 'oB'], 'an output that drifted away is pulled back beside its module')
  const filled = repairGraph([input, modA])
  eq(ids(filled).slice(0, 2), ['i1', 'mA'], 'a module with no output keeps its place')
  eq(filled.length, 3, 'and the missing output node is created')
  eq(filled[2].kind, 'output', 'the created node is an output')
  eq(filled[2].sourceModuleId, 'mA', 'pointing at its own module')
  eq(repairGraph([input, modA, outA, { ...outA, id: 'oA2' }]).length, 3, 'a duplicate output is dropped rather than chained twice')
  eq(
    ids(repairGraph([input, modA, outA, { id: 'oX', kind: 'output', sourceModuleId: 'gone', text: '' }])),
    ['i1', 'mA', 'oA'],
    'an output whose module is gone is dropped',
  )
  const rescued = repairGraph([modA, outA])
  eq(ids(rescued).slice(1), ['mA', 'oA'], 'a graph that lost its input node keeps the modules it still has')
  eq(rescued.length > 0 ? rescued[0].kind : '', 'input', 'and is given a fresh input node instead of being discarded')
  eq(repairGraph([]).length, 0, 'an empty graph stays empty')
  eq(
    repairGraph([{ id: 'oX', kind: 'output', sourceModuleId: 'gone', text: '' }]).length,
    0,
    'a graph of orphans alone stays empty',
  )

  const { input: lead, blocks } = splitBlocks([input, modA, outA, modB, outB])
  eq(lead.id, 'i1', 'the leading input node is returned separately')
  eq(blocks.map((block) => block.module.id), ['mA', 'mB'], 'blocks are read in chain order')
  eq(blocks.map((block) => block.output && block.output.id), ['oA', 'oB'], 'each block keeps its own output')
  eq(ids(flattenBlocks(lead, blocks)), ['i1', 'mA', 'oA', 'mB', 'oB'], 'flattening is the inverse of reading blocks')

  const swapped = blocks.slice()
  const moved = swapped.splice(0, 1)[0]
  swapped.splice(1, 0, moved)
  eq(
    ids(flattenBlocks(lead, swapped)),
    ['i1', 'mB', 'oB', 'mA', 'oA'],
    'the swap moveModule performs keeps each output with its module and the input in front',
  )
}

console.log('\ndisposal')
dispose()
ok(ctx.disposed.length >= 5, `every registration is released (released ${ctx.disposed.length})`)
ok(ctx.disposed.includes('translate-flow-config'), 'including the configuration page')
ok(
  ctx.disposed.filter((entry) => entry === 'translate-flow').length === 2
    && ctx.disposed.filter((entry) => entry === 'translate-flow-config').length === 2,
  'each page key and its sidebar entry are both released',
)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
