/**
 * Manifest-consistency tests for dsh-plugin-translate-flow.
 *
 * The host test suite proves the isolation contract of `lib/index.js`. It never
 * loads `lib/typert.host.js` or `lib/client.js`, so the identifiers those two
 * files repeat by hand — the package name, the four invocation ids, the service
 * key, the wire namespace, the four method names and the four type symbols —
 * were unverified. A rename or a partial edit could therefore ship a package
 * whose browser half addresses a Remote that the host never declared.
 *
 * This suite loads all three faces and asserts they agree:
 *
 *   - `package.json` name === Typert `package` === client bundle id
 *   - the bundle patch inserts one row whose `name` is the package name
 *   - every Typert invocation names a method that exists on the live service
 *   - every Typert invocation appears in the client's Remote contribution
 *   - the service's `typertRemote` binding matches the manifest
 *
 * Run: node test/manifest.test.mjs
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

/** Read a workspace file as UTF-8 text. */
function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** Parse a JSON workspace file. */
function readJson(relative) {
  return JSON.parse(read(relative))
}

/** Build the fake host context the plugin's `apply` needs. */
function makeContext() {
  const provided = {}
  return {
    provided,
    llm: {
      stream: () => (async function* stream() {})(),
      listProviders: () => [],
      listModels: () => Promise.resolve([]),
    },
    get() {
      return undefined
    },
    provide(key, service) {
      provided[key] = service
      return () => {
        delete provided[key]
      }
    },
  }
}

const pkg = readJson('package.json')
const patch = read('cordis.patch.yml')
const { TYPERT } = await import('../lib/typert.host.js')
const host = await import('../lib/index.js')

// ── package manifest ───────────────────────────────────────────────────────
console.log('\npackage manifest')
ok(typeof pkg.name === 'string' && pkg.name.length > 0, 'the package declares a name')
eq(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'the package declares its bundle patch')
eq(pkg.dsh?.client?.platform, 'web', 'the package declares a web client half')
eq(pkg.icon, './icon.svg', 'the package declares an icon')
ok(pkg.license === 'MIT', 'the package declares a license')
ok(pkg.exports?.['.'] === './lib/index.js', 'the package exports its host half')
ok(pkg.exports?.['./client'] === './lib/client.js', 'the package exports its client half')
ok(pkg.exports?.['./typert'] === './lib/typert.host.js', 'the package exports its Typert manifest')
ok(pkg.exports?.['./package.json'] === './package.json', 'the package exports its manifest')
ok(pkg.exports?.['./locale/*.json'] === './locale/*.json', 'the package exports its locale files')
for (const file of ['lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
  ok(pkg.files.includes(file), `"files" ships ${file}`)
}
ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-api-gateway'), 'the client injects the API gateway')
ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'), 'the client injects the renderer')
ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), 'the client injects the sidebar')

// ── host half ──────────────────────────────────────────────────────────────
console.log('\nhost half')
ok(host.name === 'translate-flow', 'the host plugin name is translate-flow')
eq(host.inject, ['llm', 'typert'], 'the host injects llm and typert; the tool registry stays optional')
const ctx = makeContext()
const dispose = host.apply(ctx, undefined)
const service = ctx.provided[TYPERT.invocations[0].service]
ok(service !== undefined, `apply provides the "${TYPERT.invocations[0].service}" service`)
ok(typeof dispose === 'function', 'apply returns a disposer')
for (const method of ['runModule', 'cancelRun', 'describe', 'listRoutes']) {
  ok(typeof service[method] === 'function', `the service implements ${method}()`)
}
service.describe()
const roster = service.describe()
eq(roster.modules.map((module) => module.id), ['zh2en', 'en2zh', 'zh-academic', 'en-academic'], 'the four built-in modules are declared')
eq(roster.precisionFlow, ['en2zh', 'zh-academic', 'zh2en'], 'the precision chain is the default flow')
ok(roster.modules.every((module) => module.prompt.length > 20), 'every built-in module ships a prompt')

// ── typert manifest ────────────────────────────────────────────────────────
console.log('\ntypert manifest')
eq(TYPERT.package, pkg.name, 'the Typert package matches the npm name')
eq(TYPERT.face, 'host', 'the Typert manifest declares the host face')
ok(Array.isArray(TYPERT.schemas), 'the Typert manifest declares a schemas array')
ok(Array.isArray(TYPERT.invocations) && TYPERT.invocations.length === 4, 'the Typert manifest declares four invocations')
const ids = TYPERT.invocations.map((invocation) => invocation.id)
eq(new Set(ids).size, ids.length, 'every invocation id is unique')
const methods = TYPERT.invocations.map((invocation) => invocation.method)
eq(methods.slice().sort(), ['cancelRun', 'describe', 'listRoutes', 'runModule'], 'every invocation targets a declared method')
for (const invocation of TYPERT.invocations) {
  ok(invocation.id.startsWith(`${pkg.name}#`), `invocation "${invocation.id}" is owned by the package`)
  eq(invocation.service, TYPERT.invocations[0].service, `invocation "${invocation.method}" uses the service key`)
  eq(invocation.namespace, TYPERT.invocations[0].namespace, `invocation "${invocation.method}" uses the wire namespace`)
  ok(typeof service[invocation.method] === 'function', `invocation "${invocation.method}" resolves on the live service`)
  ok(invocation.invocation?.kind === 'direct', `invocation "${invocation.method}" uses the direct receiver`)
  ok(invocation.result?.mode === 'strict' && typeof invocation.result.create === 'function', `invocation "${invocation.method}" has a strict result codec`)
  for (const parameter of invocation.parameters) {
    ok(parameter.codec?.mode === 'strict' && typeof parameter.codec.create === 'function', `invocation "${invocation.method}" parameter "${parameter.name}" has a strict codec`)
  }
}
const binding = service.typertRemote
ok(binding !== undefined && typeof binding === 'object', 'the service carries a typertRemote binding')
eq(binding.serviceKey, TYPERT.invocations[0].service, 'the binding names the manifest service key')
eq(binding.namespace, TYPERT.invocations[0].namespace, 'the binding names the manifest namespace')
ok(binding.service === service, 'the binding points at the service itself')

// ── bundle patch ───────────────────────────────────────────────────────────
console.log('\nbundle patch')
ok(patch.includes('insert:'), 'the patch inserts a loader row')
ok(patch.includes(`name: ${pkg.name}`), 'the patch names the package')
const rowIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
eq(rowIds.length, 1, `the patch declares exactly one row (got ${JSON.stringify(rowIds)})`)
ok(typeof rowIds[0] === 'string' && rowIds[0].length > 0, `the row id "${rowIds[0]}" is non-empty`)

// ── client half ────────────────────────────────────────────────────────────
console.log('\nclient half')
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}
await import('../lib/client.js')
ok(captured !== undefined, 'the client bundle registers itself with the module loader')
eq(captured.id, pkg.name, 'the client bundle id matches the npm name')
const client = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})
ok(typeof client.apply === 'function', 'the client half exports apply')
eq(client.inject, ['remote', 'slots'], 'the client injects remote and slots')
const clientText = read('lib/client.js')
for (const invocation of TYPERT.invocations) {
  ok(clientText.includes(invocation.id), `the client declares invocation id "${invocation.id}"`)
  ok(clientText.includes(`method: "${invocation.method}"`), `the client declares method "${invocation.method}"`)
  ok(clientText.includes(invocation.namespace), `the client declares namespace "${invocation.namespace}"`)
}
ok(clientText.includes('sidebar.panellist'), 'the client registers a sidebar.panellist entry')
ok(clientText.includes('name: "main"'), 'the client registers a main panel')

// ── result codecs ──────────────────────────────────────────────────────────
console.log('\nresult codecs')
const runResultCodec = TYPERT.invocations.find((invocation) => invocation.method === 'runModule').result.create()
const sampleResult = {
  runId: 'r1',
  moduleId: 'en2zh',
  output: '你好',
  cancelled: false,
  provider: 'p',
  model: 'm',
  elapsedMs: 1,
  isolation: { messagesSent: 1 },
}
ok(runResultCodec.parse({ ...sampleResult, usage: { inputTokens: 1 } }) !== undefined, 'the run codec accepts token usage')
ok(runResultCodec.parse({ ...sampleResult, usage: null }) !== undefined, 'the run codec accepts an absent usage as null')
{
  let threw = false
  try {
    runResultCodec.parse({ ...sampleResult, usage: { inputTokens: 'lots' } })
  } catch {
    threw = true
  }
  ok(threw, 'the run codec rejects a non-numeric token count')
}
const routesResultCodec = TYPERT.invocations.find((invocation) => invocation.method === 'listRoutes').result.create()
ok(
  routesResultCodec.parse({ providers: [{ id: 'p', name: 'P', models: [], status: 'timeout' }], current: null }) !== undefined,
  'the routes codec accepts a provider status',
)
{
  let threw = false
  try {
    routesResultCodec.parse({ providers: [{ id: 'p', name: 'P', models: [], status: 'fine' }], current: null })
  } catch {
    threw = true
  }
  ok(threw, 'the routes codec rejects an unknown provider status')
}

dispose()
ok(ctx.provided[TYPERT.invocations[0].service] === undefined, 'the disposer withdraws the service')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
