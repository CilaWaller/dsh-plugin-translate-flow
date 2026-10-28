/**
 * Host-half tests for dsh-plugin-translate-flow.
 *
 * These run against `lib/index.js` directly, with a fake Cordis context that
 * records exactly what the plugin hands to `ctx.llm.stream`. That is the point:
 * the isolation claim is about the shape of the dispatched request, so the
 * assertions read the real options object rather than trusting a description.
 *
 * Run: node test/host.test.mjs
 */

import { apply, inject, name } from '../lib/index.js'

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

/** Assert that `fn` rejects, and optionally that the message matches. */
async function rejects(fn, pattern, label) {
  try {
    await fn()
    ok(false, `${label} (did not reject)`)
  } catch (error) {
    const message = error?.message ?? String(error)
    ok(pattern.test(message), `${label} — ${message}`)
  }
}

/**
 * Build a fake host context.
 *
 * `stream` is a pluggable generator factory so each test can decide how the
 * provider behaves; `sent` collects every options object the plugin dispatched.
 */
function makeContext(streamFactory) {
  const sent = []
  const provided = {}
  const registeredTools = []
  const ctx = {
    sent,
    provided,
    registeredTools,
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {
          const index = registeredTools.indexOf(definition)
          if (index >= 0) registeredTools.splice(index, 1)
        }
      },
    },
    llm: {
      stream(options) {
        sent.push(options)
        const produced = streamFactory(options)
        // Factories may hand back an iterable or a generator factory; accept both
        // so a test reads naturally either way.
        return typeof produced === 'function' ? produced(options) : produced
      },
      listProviders: () => [
        { id: 'alpha', name: 'Alpha' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: (id) => (id === 'alpha'
        ? Promise.resolve([{ id: 'm1', name: 'Model One' }, { id: 'm2' }])
        : Promise.reject(new Error('unreachable'))),
    },
    get(key) {
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'agent', model: 'default-agent' }) }
      }
      // The tool registry is optional, and the host half reads it through
      // `ctx.get`: a service that is not in `inject` cannot be read as a property.
      if (key === 'tools') return ctx.tools
      return undefined
    },
    provide(key, service) {
      provided[key] = service
      return () => { delete provided[key] }
    },
  }
  return ctx
}

/** A stream that emits `text` and finishes with `kind`. */
function textStream(text, kind = 'stop') {
  return () => (async function* stream() {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind } }
  })()
}

/** A stream that never finishes on its own but honours the abort signal. */
function stalledStream(options) {
  return (async function* stream() {
    for (;;) {
      if (options.signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })()
}

/** A stream that ignores the abort signal and never yields anything. */
function deafStream() {
  return (async function* stream() {
    await new Promise(() => {})
  })()
}

/** Install the plugin and return its service. */
function install(streamFactory, config) {
  const ctx = makeContext(streamFactory)
  const dispose = apply(ctx, config)
  return { ctx, service: ctx.provided.translateFlowPanel, dispose }
}

const RUN = (over) => ({
  runId: 'r1',
  moduleId: 'en2zh',
  prompt: 'Translate into Chinese.',
  input: 'Hello world.',
  ...over,
})

// ── exports ────────────────────────────────────────────────────────────────
console.log('\nexports')
ok(name === 'translate-flow', 'plugin name is translate-flow')
eq(inject, ['llm', 'typert'], 'injects llm and typert — the tool registry stays optional')

// ── the isolation contract ─────────────────────────────────────────────────
console.log('\nisolation contract')
{
  const { ctx, service } = install(textStream('  你好，世界。  '))
  const result = await service.runModule(RUN())

  eq(ctx.sent.length, 1, 'exactly one model call was dispatched')
  const options = ctx.sent[0]
  ok(Object.isFrozen(options), 'the dispatched options object is frozen')
  ok(Object.isFrozen(options.messages), 'the message array is frozen')
  ok(Object.isFrozen(options.messages[0]), 'the message is frozen')
  eq(options.system, 'Translate into Chinese.', 'system is exactly the module prompt')
  eq(options.messages.length, 1, 'the history holds exactly one message')
  eq(options.messages[0].role, 'user', 'that message is a user message')
  eq(options.messages[0].content, [{ type: 'text', text: 'Hello world.' }], 'and holds only this module input')
  ok(!('tools' in options), 'no tools were offered')
  ok(!('toolHistory' in options), 'no tool history was offered')
  ok(!('sessionId' in options), 'no session was attached')
  ok(!('purpose' in options), 'no purpose was set')
  eq(result.output, '你好，世界。', 'the output is trimmed')
  eq(result.moduleId, 'en2zh', 'the result echoes the module id')
  eq(result.cancelled, false, 'the result is not marked cancelled')
  eq(result.provider, 'agent', 'the route fell back to the agent default provider')
  eq(result.model, 'default-agent', 'the route fell back to the agent default model')
  ok(typeof result.elapsedMs === 'number', 'the result reports elapsed time')
  eq(result.isolation.messagesSent, 1, 'isolation reports one message')
  eq(result.isolation.toolSchemas, 0, 'isolation reports no tool schemas')
  eq(result.isolation.sessionAttached, false, 'isolation reports no session')
  eq(result.isolation.systemChars, 'Translate into Chinese.'.length, 'isolation reports the prompt size')
  eq(result.isolation.inputChars, 12, 'isolation reports the input size')
  ok(Object.isFrozen(result.isolation), 'the isolation summary is frozen')
}

// ── rejected request shapes ────────────────────────────────────────────────
console.log('\nrejected request shapes')
{
  const { service } = install(textStream('x'))
  await rejects(() => service.runModule(null), /must be an object/, 'a non-object request is rejected')
  await rejects(() => service.runModule(RUN({ history: [] })), /"history" is not allowed/, 'a smuggled field is rejected')
  await rejects(() => service.runModule(RUN({ messages: [] })), /"messages" is not allowed/, 'a smuggled history is rejected')
  await rejects(() => service.runModule(RUN({ sessionId: 's' })), /"sessionId" is not allowed/, 'a smuggled session is rejected')
  await rejects(() => service.runModule(RUN({ runId: '' })), /runId must be a non-empty string/, 'an empty runId is rejected')
  await rejects(() => service.runModule(RUN({ moduleId: '' })), /moduleId must be a non-empty string/, 'an empty moduleId is rejected')
  await rejects(() => service.runModule(RUN({ prompt: '   ' })), /prompt is empty/, 'an empty prompt is rejected')
  await rejects(() => service.runModule(RUN({ input: '' })), /input is empty/, 'an empty input is rejected')
  await rejects(() => service.runModule(RUN({ prompt: 'p'.repeat(20001) })), /prompt exceeds 20000/, 'an over-long prompt is rejected')
  await rejects(() => service.runModule(RUN({ input: 'i'.repeat(200001) })), /input exceeds 200000/, 'an over-long input is rejected')
  await rejects(() => service.runModule(RUN({ provider: 'alpha' })), /provider and model must be given together/, 'a provider without a model is rejected')
  await rejects(() => service.runModule(RUN({ model: 'm1' })), /provider and model must be given together/, 'a model without a provider is rejected')
}

// ── routing ────────────────────────────────────────────────────────────────
console.log('\nrouting')
{
  const { ctx, service } = install(textStream('ok'))
  const result = await service.runModule(RUN({ provider: 'alpha', model: 'm1' }))
  eq(ctx.sent[0].provider, 'alpha', 'an explicit provider is honoured')
  eq(ctx.sent[0].model, 'm1', 'an explicit model is honoured')
  eq(result.provider, 'alpha', 'the result echoes the provider')
  eq(result.model, 'm1', 'the result echoes the model')
}
{
  const { ctx, service } = install(textStream('ok'), { provider: 'pinned', model: 'pinned-model' })
  await service.runModule(RUN())
  eq(ctx.sent[0].provider, 'pinned', 'the loader row config wins over the agent default')
  eq(ctx.sent[0].model, 'pinned-model', 'the loader row config supplies the model too')
}
{
  const ctx = makeContext(textStream('ok'))
  ctx.get = () => undefined
  apply(ctx, undefined)
  const service = ctx.provided.translateFlowPanel
  await rejects(() => service.runModule(RUN()), /no model route available/, 'with no route at all the call is refused before dispatch')
  eq(ctx.sent.length, 0, 'and nothing was dispatched')
}

// ── failure surfaces ───────────────────────────────────────────────────────
console.log('\nfailure surfaces')
{
  const { service } = install(textStream('partial', 'max-tokens'))
  await rejects(() => service.runModule(RUN()), /reached the 8192-token ceiling/, 'a truncated answer is not returned as a result')
}
{
  const { service } = install(textStream('', 'tool-calls'))
  await rejects(() => service.runModule(RUN()), /unexpectedly attempted a tool call/, 'a tool call is refused')
}
{
  const { service } = install(textStream('   '))
  await rejects(() => service.runModule(RUN()), /produced no output/, 'an empty answer is refused')
}
{
  const { service } = install(() => (async function* stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'MissingSessionID' } } }
  })())
  await rejects(() => service.runModule(RUN()), /choose another model in 模型配置/, 'a session-routing 400 carries an actionable hint')
}
{
  const { ctx, service } = install(() => (async function* stream() {
    throw new Error('socket closed')
  })())
  await rejects(() => service.runModule(RUN()), /en2zh failed: socket closed/, 'a transport throw becomes a module failure')
  eq(ctx.provided.translateFlowPanel !== undefined, true, 'the service survives the failure')
}

// ── cancellation ───────────────────────────────────────────────────────────
console.log('\ncancellation')
{
  const { service } = install(stalledStream)
  const pending = service.runModule(RUN({ runId: 'cancel-me' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const cancelled = service.cancelRun({ runId: 'cancel-me' })
  eq(cancelled, { runId: 'cancel-me', cancelled: true }, 'cancelRun reports the abort')
  const result = await pending
  eq(result.cancelled, true, 'a cancelled run resolves instead of throwing')
  eq(result.output, '', 'a cancelled run returns no output')
}
{
  const { service } = install(stalledStream)
  const pending = service.runModule(RUN({ runId: 'twice' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await rejects(() => service.runModule(RUN({ runId: 'twice' })), /already running/, 'a duplicate runId is refused while in flight')
  service.cancelRun({ runId: 'twice' })
  await pending
}
{
  const { service } = install(textStream('ok'))
  eq(service.cancelRun({ runId: 'never-started' }), { runId: 'never-started', cancelled: false }, 'cancelling an unknown run is a no-op')
  await rejects(() => service.cancelRun({}), /runId must be a non-empty string/, 'cancel requires a runId')
  await rejects(() => service.cancelRun({ runId: 'x', extra: 1 }), /"extra" is not allowed/, 'cancel rejects extra fields')
}

// ── describe ───────────────────────────────────────────────────────────────
console.log('\ndescribe')
{
  const { service } = install(textStream('ok'))
  const described = service.describe()
  eq(described.modules.map((m) => m.id), ['zh2en', 'en2zh', 'zh-academic', 'en-academic'], 'the four built-in modules are declared')
  eq(described.modules.map((m) => m.name), ['中译英', '英译中', '学术中文润色', '学术英文润色'], 'with their display names')
  ok(described.modules.every((m) => typeof m.prompt === 'string' && m.prompt.length > 20), 'every built-in module ships a prompt')
  eq(described.precisionFlow, ['en2zh', 'zh-academic', 'zh2en'], 'the default flow is the 精译 chain')
  eq(described.presets.map((preset) => preset.id), ['zh', 'en'], 'both precision presets are declared, Chinese first')
  eq(described.presets.map((preset) => preset.name), ['汉语精译', '英文精译'], 'with the names the header shows')
  eq(described.presets[0].flow, ['zh2en', 'en-academic', 'en2zh'], '汉语精译 goes out to English, polishes, and comes back')
  eq(described.presets[1].flow, ['en2zh', 'zh-academic', 'zh2en'], '英文精译 is the same round trip from English')
  eq(described.presets[1].flow, described.precisionFlow, '英文精译 is the chain a fresh panel starts from')
  {
    const moduleIds = described.modules.map((module) => module.id)
    ok(
      described.presets.every((preset) => preset.flow.every((id) => moduleIds.includes(id))),
      'every preset step names a declared module',
    )
  }
  eq(described.allowedRunKeys, ['runId', 'moduleId', 'prompt', 'input', 'provider', 'model'], 'the allowed request keys are published')
  eq(described.limits.maxInputChars, 200000, 'the input ceiling is published')
  eq(described.limits.maxTokens, 8192, 'the token ceiling is published')
  const frozen = service.describe()
  frozen.modules[0].name = 'mutated'
  eq(service.describe().modules[0].name, '中译英', 'describe returns a fresh roster each call')
}

// ── listRoutes ─────────────────────────────────────────────────────────────
console.log('\nlistRoutes')
{
  const { service } = install(textStream('ok'))
  const routes = await service.listRoutes()
  eq(routes.providers.map((p) => p.id), ['alpha', 'broken'], 'every provider is listed')
  eq(routes.providers[0].models, [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'm2' }], 'models are normalised')
  eq(routes.providers[1].models, [], 'an unreachable provider degrades to an empty model list')
  eq(routes.providers[0].status, 'ok', 'a reachable provider reports ok')
  eq(routes.providers[1].status, 'error', 'an unreachable provider reports why its list is empty')
  eq(routes.current, { provider: 'agent', model: 'default-agent' }, 'the route in force is reported')
}

// ── lifecycle ──────────────────────────────────────────────────────────────
console.log('\nlifecycle')
{
  const { ctx, dispose } = install(textStream('ok'))
  ok(typeof ctx.provided.translateFlowPanel.runModule === 'function', 'the service is provided under translateFlowPanel')
  const binding = ctx.provided.translateFlowPanel.typertRemote
  eq(binding.serviceKey, 'translateFlowPanel', 'the remote binding names the service key')
  eq(binding.namespace, 'translateFlow', 'the remote binding names the wire namespace')
  ok(binding.service === ctx.provided.translateFlowPanel, 'the remote binding points at the service itself')
  dispose()
  ok(ctx.provided.translateFlowPanel === undefined, 'the disposer withdraws the service')
}

// ── token usage ────────────────────────────────────────────────────────────
console.log('\ntoken usage')
{
  const { service } = install(() => (async function* stream() {
    yield { type: 'text-delta', index: 0, text: '你好' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const result = await service.runModule(RUN())
  eq(result.usage, { inputTokens: 12, outputTokens: 3 }, 'reported token usage survives to the result')
}
{
  const { service } = install(textStream('ok'))
  const result = await service.runModule(RUN())
  eq(result.usage, null, 'a provider that reports no usage yields null rather than a guess')
}
{
  const { service } = install(() => (async function* stream() {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'usage', usage: { inputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const result = await service.runModule(RUN())
  eq(Object.keys(result.usage), ['inputTokens'], 'a partial usage report carries only the counters the provider gave')
  ok(!('totalTokens' in result.usage), 'and never a key whose value is undefined, which is not lossless JSON')
}

// ── the deadline releases a stalled call ───────────────────────────────────
console.log('\ndeadline')
{
  const { service } = install(deafStream, { timeoutMs: 1000 })
  await rejects(
    () => service.runModule(RUN({ runId: 'deaf' })),
    /was aborted after 1000 ms/,
    'a provider that ignores the abort signal is still released by the deadline',
  )
}
{
  const { service } = install(textStream('ok'), { timeoutMs: 1500 })
  eq(service.describe().limits.timeoutMs, 1500, 'the loader row may set the per-call budget')
}
{
  const { service } = install(textStream('ok'), { timeoutMs: 10 })
  eq(service.describe().limits.timeoutMs, 300000, 'an out-of-range budget is ignored rather than clamped')
}
{
  const { service } = install(deafStream, { timeoutMs: 5000 })
  const pending = service.runModule(RUN({ runId: 'deaf-cancel' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const marked = Date.now()
  service.cancelRun({ runId: 'deaf-cancel' })
  const result = await pending
  eq(result.cancelled, true, 'cancelling a provider that ignores the signal resolves the run')
  ok(Date.now() - marked < 1000, 'and it resolves on the abort, not by waiting out the provider')
  const revived = service.runModule(RUN({ runId: 'deaf-cancel' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  eq(service.cancelRun({ runId: 'deaf-cancel' }).cancelled, true, 'the runId is free again once that run returned')
  await revived
}

// ── the agent tool ─────────────────────────────────────────────────────────
console.log('\nagent tool')
{
  const { ctx } = install(textStream('译文'))
  eq(ctx.registeredTools.length, 1, 'activation registers exactly one agent tool')
  const tool = ctx.registeredTools[0]
  eq(tool.name, 'translate_flow', 'the tool is named translate_flow')
  ok(tool.description.includes('isolated'), 'the description states the isolation up front')
  eq(tool.parameters.required, ['text'], 'text is the only required argument')
  ok(tool.output !== undefined && typeof tool.output.render === 'function', 'the tool declares how its result renders')
}
{
  // The registry validates the body's value against `output.schema` with
  // `additionalProperties: false`, and refuses anything it cannot snapshot as
  // lossless JSON — after the chain has already been billed.
  const { ctx } = install(textStream('译文'))
  const tool = ctx.registeredTools[0]
  ok(tool.output.schema.additionalProperties === false, 'the output schema really does forbid undeclared fields')
  const value = await tool.execute({ text: 'Hello' }, { signal: undefined })
  const declared = Object.keys(tool.output.schema.properties)
  eq(
    Object.keys(value).filter((key) => !declared.includes(key)),
    [],
    'the tool returns no field its own output schema does not declare',
  )
  const hasUndefined = (node) => {
    if (node === undefined) return true
    if (Array.isArray(node)) return node.some(hasUndefined)
    if (node !== null && typeof node === 'object') return Object.values(node).some(hasUndefined)
    return false
  }
  ok(!hasUndefined(value), 'and nothing in that value is undefined, so it is lossless JSON')
}
{
  const { ctx } = install(textStream('译文'))
  const tool = ctx.registeredTools[0]
  const value = await tool.execute({ text: 'Hello' }, { signal: undefined })
  eq(value.steps.map((step) => step.moduleId), ['en2zh', 'zh-academic', 'zh2en'], 'omitting steps runs the built-in 精译 chain')
  eq(value.steps[0].output, '译文', 'every step reports its output')
  eq(ctx.sent.length, 3, 'the chain dispatched one isolated call per step')
  ok(
    ctx.sent.every((options) => !('tools' in options) && !('toolHistory' in options) && !('sessionId' in options)),
    'no step of a tool chain offered tools or a session',
  )
  ok(ctx.sent.every((options) => options.messages.length === 1), 'every tool step sent a one-message history')
  const rendered = tool.output.render({ text: 'Hello' }, value)
  eq(rendered[0].type, 'text', 'the rendered result is a text block')
  ok(rendered[0].text.includes('en2zh'), 'the rendered text names the steps')
}
{
  const { ctx } = install(textStream('OK'))
  const tool = ctx.registeredTools[0]
  const single = await tool.execute({ text: 'hi', steps: [{ moduleId: 'one', prompt: 'P1' }] }, { signal: undefined })
  eq(single.steps.map((step) => step.moduleId), ['one'], 'explicit steps are honoured')
  eq(ctx.sent.length, 1, 'one step means one call')
  const routed = await tool.execute(
    { text: 'hi', provider: 'alpha', model: 'm1', steps: [{ prompt: 'P' }] },
    { signal: undefined },
  )
  eq(routed.provider, 'alpha', 'the tool honours an explicit route')
  eq(ctx.sent[1].provider, 'alpha', 'and dispatches it')
}
{
  const { ctx } = install(textStream('x'))
  const tool = ctx.registeredTools[0]
  await rejects(() => tool.execute({ text: 'x', extra: 1 }, { signal: undefined }), /"extra" is not allowed/, 'the tool rejects an unknown argument')
  await rejects(() => tool.execute({ text: '   ' }, { signal: undefined }), /tool\.text is empty/, 'the tool rejects empty text')
  await rejects(() => tool.execute({ text: 'x', provider: 'p' }, { signal: undefined }), /provider and model must be given together/, 'the tool refuses a half route')
  await rejects(() => tool.execute({ text: 'x', steps: [] }, { signal: undefined }), /non-empty array/, 'the tool refuses an empty step list')
  await rejects(() => tool.execute({ text: 'x', steps: [{ prompt: '  ' }] }, { signal: undefined }), /non-empty string/, 'the tool refuses an empty step prompt')
  eq(ctx.sent.length, 0, 'none of those reached a provider')
}
{
  const ctx = makeContext(textStream('ok'))
  ctx.tools = undefined
  ctx.get = () => undefined
  const dispose = apply(ctx, undefined)
  ok(ctx.provided.translateFlowPanel !== undefined, 'a host that exposes no tool registry still activates the panel')
  dispose()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
