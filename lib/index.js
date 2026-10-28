/**
 * Host half of the custom translation flow.
 *
 * ## What this is
 *
 * The panel is a node graph. A **module** is one prompt plus one model. The
 * user drops modules into a chain; the panel appends the matching output node
 * after each one and runs the chain from top to bottom. Only the text of the
 * previous module's output is ever handed to the next module.
 *
 * ## The isolation contract
 *
 * Every module run is a **separate, from-scratch model request**. A run never
 * shares a conversation, a prompt, a tool set, an agent, or a session with any
 * other run. The only thing that crosses a module boundary is the previous
 * module's output *text*, which the panel passes back in as the next module's
 * `input`.
 *
 * This module enforces that structurally rather than by convention:
 *
 *   - `runModule` accepts exactly `{ runId, moduleId, prompt, input, provider,
 *     model }` and rejects any other field with a readable message. There is no
 *     field through which a caller could supply history, tools, a system
 *     prompt section, or a session id.
 *   - The request object is assembled inside `runIsolatedModule` and frozen:
 *     `system` is the module's own prompt, `messages` is a fresh one-element
 *     array holding only this module's input.
 *   - `tools`, `toolHistory` and `sessionId` are never set, so the call cannot
 *     see the agent's tool schemas, the session transcript, or any
 *     system-prompt section contributed by another plugin.
 *   - The result carries an `isolation` block describing exactly what went out,
 *     so the panel can show it instead of asking the user to take it on trust.
 *
 * Note what isolation does *not* mean: the host cannot tell whether the text a
 * caller passes as `input` was produced by the previous module or typed by
 * hand. It guarantees the *request shape* — one prompt, one input, nothing
 * else — not the provenance of the string. That is the strongest guarantee a
 * single-call API can make, and it is the one the panel relies on.
 *
 * ## Model routing
 *
 * Which provider/model answers is a **separate axis** from what the model sees.
 * A run may name its own `provider`/`model` (each module card has its own
 * choice); when it names neither, the host falls back to:
 *
 *   1. the loader row's `config: { provider, model }` — the durable default;
 *   2. the session's configured agent model.
 *
 * That second fallback matters in practice. Providers that route requests per
 * conversation (for example an OpenCode gateway requiring an
 * `x-opencode-session` header) reject a session-less call with a 400, because
 * this plugin intentionally sends no `sessionId`. Selecting a plain
 * Messages/OpenAI-compatible provider is the fix, which is why the panel
 * exposes the choice.
 *
 * ## Cancellation
 *
 * Every run is registered under its `runId` so `cancelRun` can abort it, and
 * every run is additionally bounded by `RUN_TIMEOUT_MS` so a stalled provider
 * cannot hold the panel open — or bill — forever.
 *
 * ## Why this file imports nothing
 *
 * A profile-local plugin cannot rely on resolving DSH's own packages: the
 * profile's shared `node_modules` belongs to the launcher's runtime resolution,
 * and a freshly added entry is not in the snapshot the launcher computed at
 * startup. Importing `@deepseek-ai/dsh-typert-protocol` therefore fails with
 * `ERR_MODULE_NOT_FOUND` and the entry never activates.
 *
 * The gateway's host half does not require that base class. It resolves the
 * service with `ctx.get('translateFlowPanel')` and then checks exactly one
 * thing: `Reflect.get(service, 'typertRemote')` must be an object whose
 * `service` is the receiver itself, whose `serviceKey` matches, and whose
 * `namespace` is a string. A plain object registered with `ctx.provide()`
 * satisfies that contract, so this plugin needs zero imports and stays
 * activation-safe.
 *
 * @module dsh-plugin-translate-flow
 */

/** Cordis service key this plugin occupies. */
const SERVICE_KEY = 'translateFlowPanel'
/** Wire namespace the browser reaches as the `remote.translateFlow` service. */
const NAMESPACE = 'translateFlow'

/**
 * The four built-in modules.
 *
 * These are the panel's starting material: each one already has a name, a
 * prompt and a language direction, so a user can build a working chain without
 * authoring anything. The panel edits copies of these; nothing here is mutated
 * at runtime.
 */
const BUILTIN_MODULES = Object.freeze([
  Object.freeze({
    id: 'zh2en',
    name: '中译英',
    nameEn: 'ZH → EN',
    from: 'Chinese',
    to: 'English',
    prompt: 'You are a professional Chinese-to-English translator. Translate the user\'s text into natural, idiomatic English while preserving meaning, names and numbers. Output only the translation.',
  }),
  Object.freeze({
    id: 'en2zh',
    name: '英译中',
    nameEn: 'EN → ZH',
    from: 'English',
    to: 'Chinese',
    prompt: 'You are a professional English-to-Simplified-Chinese translator. Translate the user\'s text faithfully and completely. Preserve names, numbers and formatting. Output only the translation.',
  }),
  Object.freeze({
    id: 'zh-academic',
    name: '学术中文润色',
    nameEn: 'Academic Chinese polish',
    from: 'Chinese',
    to: 'Chinese',
    prompt: '你是资深中文学术编辑。请将用户提供的中文文本润色为自然、流畅、地道的学术中文表达，保持原意、事实、数字和专有名词不变，不增删信息。只输出润色后的中文文本。',
  }),
  Object.freeze({
    id: 'en-academic',
    name: '学术英文润色',
    nameEn: 'Academic English polish',
    from: 'English',
    to: 'English',
    prompt: 'You are a professional academic English editor. Polish the user\'s English text for clarity, flow and academic tone while preserving meaning, facts, names and numbers. Output only the polished text.',
  }),
])

/**
 * The 精译 preset: English source in, Chinese translation, Chinese polish,
 * English back-translation out. The panel builds this chain on first run.
 */
const PRECISION_FLOW = Object.freeze(['en2zh', 'zh-academic', 'zh2en'])

/** Fields a run request may carry. Anything else is a contract violation. */
const ALLOWED_RUN_KEYS = Object.freeze(['runId', 'moduleId', 'prompt', 'input', 'provider', 'model'])

/** Fields a cancel request may carry. */
const ALLOWED_CANCEL_KEYS = Object.freeze(['runId'])

/** Input size ceiling, in UTF-16 code units, per module. */
const MAX_INPUT_CHARS = 200000

/** Prompt size ceiling, in UTF-16 code units, per module. */
const MAX_PROMPT_CHARS = 20000

/** Identifier ceiling for `runId` and `moduleId`. */
const MAX_ID_CHARS = 128

/**
 * Generation settings every module shares.
 *
 * They are constants rather than request fields on purpose: a module is a
 * prompt plus a model, and letting a caller also set sampling parameters would
 * widen the request surface for no expressive gain. Every module is a
 * deterministic-as-possible rewrite, so the temperature stays low.
 */
const RUN_TEMPERATURE = 0.3
const RUN_MAX_TOKENS = 8192

/**
 * Default budget for one module's model call.
 *
 * A stalled provider must not hold the run open forever. Two mechanisms enforce
 * that, and they do not promise the same thing: the abort signal *asks* the
 * provider to stop, and the deadline inside `consumeStream` stops *waiting*
 * whether or not it does. A provider that ignores the signal therefore stops
 * blocking its run — and its `runId` — at the deadline, but its own socket is
 * released only when its adapter gives up: this plugin cannot preempt an
 * iterator that never settles.
 *
 * The loader row's `config.timeoutMs` overrides the default within the bounds
 * below.
 */
const RUN_TIMEOUT_MS = 300000

/** Lower bound for a configured per-call budget, in milliseconds. */
const MIN_RUN_TIMEOUT_MS = 1000
/** Upper bound for a configured per-call budget, in milliseconds. */
const MAX_RUN_TIMEOUT_MS = 600000

/** Most steps one agent tool call may chain. */
const MAX_TOOL_STEPS = 12

/**
 * Per-provider budget for the model query behind the picker.
 *
 * `llm.listModels` may interrogate a provider over the network and it accepts
 * no abort signal, so the query is raced against this bound instead: a slow or
 * unreachable provider yields an empty model list rather than hanging the
 * picker. Discovery is convenience, never a precondition for translating.
 */
const MODEL_QUERY_TIMEOUT_MS = 2500

/**
 * Resolve to a tagged outcome once the budget elapses.
 *
 * A bare `undefined` cannot distinguish "the provider has no models" from "the
 * provider never answered", and the panel shows those differently.
 * @param promise - the query to bound.
 * @param ms - budget in milliseconds.
 * @returns `{ ok: true, value }`, `{ ok: false, reason: 'timeout' }` or
 *   `{ ok: false, reason: 'error' }`.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, reason: 'timeout' })
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, reason: 'error' })
      },
    )
  })
}

/**
 * Race one async step against a deadline and an abort signal.
 *
 * A provider that neither yields nor rejects is the one failure a plain
 * `for await` cannot survive: it holds the caller forever even after the abort
 * signal fired. Racing each `next()` bounds the *caller* whatever the source
 * does, which is what lets a run finish as timed out or cancelled instead of
 * hanging with its `runId` still reserved.
 * @param step - the pending `iterator.next()` promise.
 * @param ms - milliseconds left before the deadline.
 * @param signal - the run's abort signal, or `undefined`.
 * @returns `'deadline'`, `'abort'`, or the iterator result.
 */
function raceStep(step, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (settle) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = () => finish(() => resolve('abort'))
    // A step that loses the race may still settle later; keeping a handler on it
    // is what stops that late rejection becoming an unhandled rejection.
    step.then(() => {}, () => {})
    timer = setTimeout(() => finish(() => resolve('deadline')), ms)
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        finish(() => resolve('abort'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    step.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

/**
 * Consume a chunk stream under a deadline and an abort signal.
 *
 * `onChunk` is never called after the deadline or the abort, so a caller can
 * treat its accumulator as exactly what arrived in time.
 * @param iterable - the stream returned by `llm.stream`.
 * @param deadlineAt - epoch milliseconds after which waiting is abandoned.
 * @param signal - the run's abort signal.
 * @param onChunk - receives every chunk that arrived in time.
 * @returns `'complete'`, `'abort'` or `'deadline'`.
 */
async function consumeStream(iterable, deadlineAt, signal, onChunk) {
  if (iterable === null || iterable === undefined || typeof iterable[Symbol.asyncIterator] !== 'function') {
    throw new Error('translate-flow: the provider returned no chunk stream')
  }
  const iterator = iterable[Symbol.asyncIterator]()
  let outcome = 'complete'
  try {
    for (;;) {
      if (signal !== undefined && signal !== null && signal.aborted) {
        outcome = 'abort'
        break
      }
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        outcome = 'deadline'
        break
      }
      const settled = await raceStep(iterator.next(), remaining, signal)
      if (settled === 'deadline') {
        outcome = 'deadline'
        break
      }
      if (settled === 'abort') {
        outcome = 'abort'
        break
      }
      if (settled.done === true) {
        outcome = 'complete'
        break
      }
      onChunk(settled.value)
    }
  } finally {
    // Release the source without waiting on it: a provider that ignores the
    // abort signal must not be able to block the release path as well.
    try {
      const closing = iterator.return?.()
      if (closing !== null && closing !== undefined && typeof closing.then === 'function') {
        closing.then(() => {}, () => {})
      }
    } catch {
      /* the source refused to close; the deadline already released the caller */
    }
  }
  return outcome
}

/** @returns true for a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @returns true for a non-empty string. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Reject any request that carries more than one prompt and one input.
 *
 * This is the runtime half of the isolation contract: a caller that tries to
 * smuggle history, tools or another module's context into a call fails loudly
 * instead of silently influencing the model.
 * @param request - the untrusted request payload.
 * @returns the validated run specification.
 */
function admitRun(request) {
  if (!isRecord(request)) {
    throw new Error('translate-flow: request must be an object carrying { runId, moduleId, prompt, input }')
  }
  for (const key of Object.keys(request)) {
    if (!ALLOWED_RUN_KEYS.includes(key)) {
      throw new Error(
        `translate-flow: request field ${JSON.stringify(key)} is not allowed; a module receives only its own prompt and its own input`,
      )
    }
  }

  const runId = request.runId
  if (!isNonEmptyString(runId)) throw new Error('translate-flow: runId must be a non-empty string')
  if (runId.length > MAX_ID_CHARS) throw new Error(`translate-flow: runId exceeds ${MAX_ID_CHARS} characters`)

  const moduleId = request.moduleId
  if (!isNonEmptyString(moduleId)) throw new Error('translate-flow: moduleId must be a non-empty string')
  if (moduleId.length > MAX_ID_CHARS) throw new Error(`translate-flow: moduleId exceeds ${MAX_ID_CHARS} characters`)

  const prompt = request.prompt
  if (typeof prompt !== 'string') throw new Error('translate-flow: prompt must be a string')
  if (prompt.trim().length === 0) throw new Error('translate-flow: prompt is empty')
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`translate-flow: prompt exceeds ${MAX_PROMPT_CHARS} characters`)
  }

  const input = request.input
  if (typeof input !== 'string') throw new Error('translate-flow: input must be a string')
  if (input.trim().length === 0) throw new Error('translate-flow: input is empty')
  if (input.length > MAX_INPUT_CHARS) {
    throw new Error(`translate-flow: input exceeds ${MAX_INPUT_CHARS} characters`)
  }

  // A route is either fully named or fully absent. "provider but no model" is
  // almost always a half-finished UI state, and guessing which half the caller
  // meant would hide the mistake.
  const hasProvider = request.provider !== undefined && request.provider !== null
  const hasModel = request.model !== undefined && request.model !== null
  if (hasProvider !== hasModel) {
    throw new Error('translate-flow: provider and model must be given together, or both omitted')
  }
  if (hasProvider) {
    if (!isNonEmptyString(request.provider)) throw new Error('translate-flow: provider must be a non-empty string')
    if (!isNonEmptyString(request.model)) throw new Error('translate-flow: model must be a non-empty string')
  }

  return Object.freeze({
    runId,
    moduleId,
    prompt,
    input,
    provider: hasProvider ? request.provider : undefined,
    model: hasModel ? request.model : undefined,
  })
}

/**
 * Validate a cancellation request.
 * @param request - the untrusted payload.
 * @returns the validated run id.
 */
function admitCancel(request) {
  if (!isRecord(request)) throw new Error('translate-flow: cancel must be an object carrying { runId }')
  for (const key of Object.keys(request)) {
    if (!ALLOWED_CANCEL_KEYS.includes(key)) {
      throw new Error(`translate-flow: cancel field ${JSON.stringify(key)} is not allowed`)
    }
  }
  if (!isNonEmptyString(request.runId)) throw new Error('translate-flow: runId must be a non-empty string')
  return request.runId
}

/**
 * Read a route out of the loader row's config, when one is set there.
 * @param config - the loader row config.
 * @returns the configured route, or `undefined`.
 */
function routeFromConfig(config) {
  if (!isRecord(config)) return undefined
  if (!isNonEmptyString(config.provider) || !isNonEmptyString(config.model)) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Read the per-call budget out of the loader row, when one is set there.
 *
 * An out-of-range or non-numeric value is ignored rather than clamped: silently
 * turning a typo into a 10-minute budget would hide the mistake, and the default
 * is always safe.
 * @param config - the loader row config.
 * @returns the budget in milliseconds.
 */
function timeoutFromConfig(config) {
  if (!isRecord(config)) return RUN_TIMEOUT_MS
  const value = config.timeoutMs
  if (typeof value !== 'number' || !Number.isFinite(value)) return RUN_TIMEOUT_MS
  if (value < MIN_RUN_TIMEOUT_MS || value > MAX_RUN_TIMEOUT_MS) return RUN_TIMEOUT_MS
  return Math.floor(value)
}

/**
 * Normalise the provider's token accounting into a JSON-safe shape.
 *
 * `StreamChunk` carries a `usage` chunk; dropping it was leaving the panel's
 * cost readout with nothing to show, and keeping it costs one field on the
 * result type.
 * @param usage - the chunk's usage record.
 * @returns a frozen summary, or `undefined` when the chunk carried none.
 */
function normalizeUsage(usage) {
  if (!isRecord(usage)) return undefined
  const number = (key) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : undefined)
  // A key is added only when the provider actually reported it. A property whose
  // value is `undefined` is not lossless JSON, and both the Remote carrier and
  // the tool-result validator reject a value they cannot snapshot verbatim.
  const summary = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    const value = number(key)
    if (value !== undefined) summary[key] = value
  }
  if (Object.keys(summary).length === 0) return undefined
  return Object.freeze(summary)
}

/**
 * Resolve the fallback route: the session's configured default agent model.
 * @param ctx - host context.
 * @returns the route to call, or `undefined` when none is available.
 */
function defaultSelection(ctx) {
  const configured = ctx.get('agentDefaultModel')
  const selection = configured && typeof configured.currentSelection === 'function'
    ? configured.currentSelection()
    : undefined
  if (selection && isNonEmptyString(selection.provider) && isNonEmptyString(selection.model)) {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/**
 * Explain the one failure that is a routing choice rather than a real fault.
 *
 * Some providers route per conversation and reject a call that carries no
 * session. This plugin sends no `sessionId` on purpose, so the actionable advice
 * is to pick a different provider in the panel rather than to retry.
 * @param message - the provider's failure text.
 * @returns a short hint, or an empty string.
 */
function routingHint(message) {
  if (!/x-opencode-session|MissingSessionID/i.test(message)) return ''
  return ' — this provider requires a per-conversation routing header, and every module here is deliberately session-less; choose another model in 模型配置.'
}

/**
 * Run one module as a fresh, self-contained model call.
 *
 * The options object is assembled here and nowhere else. It carries the
 * module's own `system` prompt and a brand-new single-message history, and it
 * deliberately omits `tools`, `toolHistory` and `sessionId`. That omission is
 * what makes the call invisible to the agent loop and to every other plugin.
 *
 * @param llm - the host `llm` service.
 * @param selection - provider and model route to call.
 * @param spec - the validated run specification.
 * @param record - the run's cancellation record.
 * @param timeoutMs - per-call budget in milliseconds.
 * @returns the model's text output, what was sent, and what it cost.
 */
async function runIsolatedModule(llm, selection, spec, record, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs
  const timer = setTimeout(() => {
    record.timedOut = true
    record.controller.abort()
  }, timeoutMs)

  // Frozen: `llm/stream` is a Cordis waterfall, so a listener could otherwise
  // rewrite this request in flight. Freezing keeps the isolation contract true
  // at dispatch, not merely at construction.
  const options = Object.freeze({
    provider: selection.provider,
    model: selection.model,
    // The module's own prompt, and nothing else.
    system: spec.prompt,
    // A fresh history: exactly one user message holding exactly this input.
    messages: Object.freeze([
      Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: spec.input })]) }),
    ]),
    temperature: RUN_TEMPERATURE,
    maxTokens: RUN_MAX_TOKENS,
    signal: record.controller.signal,
    // Deliberately absent: tools, toolHistory, sessionId, purpose.
  })

  // Read off the object handed to `llm.stream`, so the panel's evidence follows
  // the request instead of a constant that could drift away from it.
  const isolation = describeIsolation(spec, options)

  let text = ''
  let failure
  let finishKind
  let usage
  let outcome
  let thrown
  try {
    outcome = await consumeStream(llm.stream(options), deadlineAt, record.controller.signal, (chunk) => {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = normalizeUsage(chunk.usage)
      else if (chunk.type === 'finish') {
        finishKind = chunk.reason && chunk.reason.kind
        if (finishKind === 'error' || finishKind === 'aborted') failure = chunk.reason.failure
      } else if (chunk.type === 'error') {
        failure = chunk.failure ?? chunk.error ?? { message: 'model call failed' }
      }
    })
  } catch (error) {
    thrown = error
  } finally {
    clearTimeout(timer)
  }

  // The deadline is the one case where a non-cooperative provider is reported as
  // the timeout it is, rather than as an empty translation. It is keyed on the
  // timer's own flag, because the timer aborts the signal: a timed-out call also
  // surfaces as an abort and must not be mistaken for a user cancellation.
  if (record.timedOut || outcome === 'deadline') {
    const detail = thrown !== undefined && !(thrown instanceof Error && /no chunk stream/.test(thrown.message))
      ? `: ${errorMessage(thrown)}`
      : failure !== undefined
        ? `: ${errorMessage(failure)}`
        : ''
    throw new Error(`translate-flow: ${spec.moduleId} was aborted after ${timeoutMs} ms${detail}`)
  }
  // A cancellation resolves: the panel shows a stopped run, not a failure.
  if (record.cancelled || outcome === 'abort' || finishKind === 'aborted') {
    return { cancelled: true, output: text, isolation, usage }
  }
  if (thrown !== undefined) {
    throw new Error(`translate-flow: ${spec.moduleId} failed: ${errorMessage(thrown)}${routingHint(errorMessage(thrown))}`)
  }
  if (failure !== undefined) {
    const message = errorMessage(failure)
    throw new Error(`translate-flow: ${spec.moduleId} failed: ${message}${routingHint(message)}`)
  }
  // A truncated answer is not a translation. `max-tokens` means the provider cut
  // the output at the ceiling, and `tool-calls` means it tried to call a tool
  // this request never offered; neither is a result, so neither is returned.
  if (finishKind === 'max-tokens') {
    throw new Error(
      `translate-flow: ${spec.moduleId} reached the ${RUN_MAX_TOKENS}-token ceiling and was truncated; shorten the input`,
    )
  }
  if (finishKind === 'tool-calls') {
    throw new Error(`translate-flow: ${spec.moduleId} unexpectedly attempted a tool call`)
  }
  const output = text.trim()
  if (output.length === 0) throw new Error(`translate-flow: ${spec.moduleId} produced no output`)
  return { cancelled: false, output, isolation, usage }
}

/**
 * Describe exactly what one run sends.
 *
 * Every number here is read off the options object the plugin hands to
 * `llm.stream`, so an edit that widened the request would move these numbers
 * with it. That is the whole point: the panel's isolation badges are a
 * measurement of the dispatched call, not a repetition of a claim.
 * @param spec - the validated run specification.
 * @param options - the frozen options object dispatched to `llm.stream`.
 * @returns the isolation summary.
 */
function describeIsolation(spec, options) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  return Object.freeze({
    messagesSent: messages.length,
    historyMessages: Math.max(0, messages.length - 1),
    toolSchemas: Array.isArray(options.tools) ? options.tools.length : 0,
    sessionAttached: options.sessionId !== undefined && options.sessionId !== null,
    systemChars: typeof options.system === 'string' ? options.system.length : 0,
    inputChars: spec.input.length,
  })
}

/**
 * Extract a readable message from anything a provider may throw.
 * @param failure - the thrown value or failure record.
 * @returns the message text.
 */
function errorMessage(failure) {
  if (failure === undefined || failure === null) return 'model call failed'
  if (typeof failure === 'string') return failure
  if (typeof failure.message === 'string' && failure.message.length > 0) return failure.message
  return String(failure)
}

/**
 * Validate the agent tool's arguments.
 *
 * The tool is a second door into the same isolated call, so it validates its own
 * surface here and then hands each step to `admitRun`, which owns the size
 * limits and the readable rejections.
 * @param args - the untrusted tool arguments.
 * @param service - the panel service, used for its authoritative module roster.
 * @returns a frozen `{ text, steps, provider, model }`.
 */
function admitToolRequest(args, service) {
  if (!isRecord(args)) throw new Error('translate-flow: the tool takes an object argument')
  for (const key of Object.keys(args)) {
    if (!['text', 'steps', 'provider', 'model'].includes(key)) {
      throw new Error(`translate-flow: tool field ${JSON.stringify(key)} is not allowed`)
    }
  }
  if (typeof args.text !== 'string') throw new Error('translate-flow: tool.text must be a string')
  if (args.text.trim().length === 0) throw new Error('translate-flow: tool.text is empty')

  const hasProvider = args.provider !== undefined && args.provider !== null
  const hasModel = args.model !== undefined && args.model !== null
  if (hasProvider !== hasModel) {
    throw new Error('translate-flow: provider and model must be given together, or both omitted')
  }
  if (hasProvider && (!isNonEmptyString(args.provider) || !isNonEmptyString(args.model))) {
    throw new Error('translate-flow: provider and model must be non-empty strings')
  }

  let steps
  if (args.steps === undefined || args.steps === null) {
    // The built-in 精译 chain, read from the same roster the panel renders.
    const roster = service.describe()
    const byId = new Map(roster.modules.map((module) => [module.id, module]))
    steps = roster.precisionFlow.map((id) => ({ moduleId: id, prompt: byId.get(id).prompt }))
  } else {
    if (!Array.isArray(args.steps) || args.steps.length === 0) {
      throw new Error('translate-flow: tool.steps must be a non-empty array when present')
    }
    if (args.steps.length > MAX_TOOL_STEPS) {
      throw new Error(`translate-flow: tool.steps exceeds ${MAX_TOOL_STEPS} steps`)
    }
    steps = args.steps.map((step, index) => {
      if (!isRecord(step)) throw new Error(`translate-flow: tool.steps[${index}] must be an object`)
      for (const key of Object.keys(step)) {
        if (!['moduleId', 'prompt'].includes(key)) {
          throw new Error(`translate-flow: tool.steps[${index}] field ${JSON.stringify(key)} is not allowed`)
        }
      }
      if (typeof step.prompt !== 'string' || step.prompt.trim().length === 0) {
        throw new Error(`translate-flow: tool.steps[${index}].prompt must be a non-empty string`)
      }
      return {
        moduleId: isNonEmptyString(step.moduleId) ? step.moduleId : `step-${index + 1}`,
        prompt: step.prompt,
      }
    })
  }

  return Object.freeze({
    text: args.text,
    steps: Object.freeze(steps),
    provider: hasProvider ? args.provider : undefined,
    model: hasModel ? args.model : undefined,
  })
}

/** Render a finished chain as the text block the tool result shows. */
function renderChain(value) {
  const steps = isRecord(value) && Array.isArray(value.steps) ? value.steps : []
  if (steps.length === 0) return 'translate_flow: no steps ran'
  return steps
    .map((step, index) => {
      const label = isNonEmptyString(step.moduleId) ? step.moduleId : `step ${index + 1}`
      return `### ${index + 1}. ${label}\n${typeof step.output === 'string' ? step.output : ''}`
    })
    .join('\n\n')
}

/**
 * Build the agent-facing twin of the panel.
 *
 * One tool call runs a chain of isolated module calls, exactly as the panel
 * does: each step receives only its own prompt and the previous step's output.
 * The session is never attached, so a tool call is as invisible to the session
 * transcript as a panel run is — the trade-off the README documents.
 * @param ctx - host context.
 * @param resolveSelection - returns the route to call, or `undefined`.
 * @param timeoutMs - per-step budget in milliseconds.
 * @param service - the panel service, reused for its module roster.
 * @returns a tool definition for `ctx.tools.register`.
 */
function defineTranslateTool(ctx, resolveSelection, timeoutMs, service) {
  return {
    name: 'translate_flow',
    description: [
      'Translate or polish text through an isolated chain: one model call per step,',
      "each receiving only its own prompt and the previous step's output.",
      'No session history, no tools and no other plugin context reach the model.',
      'Use it for one-off translation, for removing translationese from Chinese, or for an',
      'EN to ZH to polish to EN round trip. Omit `steps` to run the built-in 精译 chain',
      '(en2zh, zh-academic, zh2en).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to run through the chain.' },
        steps: {
          type: 'array',
          description: 'Ordered steps; each one is a system prompt. Omit for the built-in 精译 chain.',
          items: {
            type: 'object',
            properties: {
              moduleId: { type: 'string', description: 'Label for this step, such as "en2zh".' },
              prompt: { type: 'string', description: 'The system prompt this step sends.' },
            },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
        provider: { type: 'string', description: 'Optional provider route used for every step.' },
        model: { type: 'string', description: 'Optional model id used for every step.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          model: { type: 'string' },
          // Declared because `additionalProperties: false` is enforced against
          // the body's returned value: an undeclared field fails the call *after*
          // the whole chain has already been billed.
          input: { type: 'string', description: 'The text the chain started from.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                moduleId: { type: 'string' },
                prompt: { type: 'string' },
                output: { type: 'string' },
                elapsedMs: { type: 'number' },
              },
              required: ['moduleId', 'output'],
              additionalProperties: true,
            },
          },
        },
        required: ['provider', 'model', 'steps'],
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: renderChain(value) }],
    },
    async execute(args, exec) {
      const parsed = admitToolRequest(args, service)
      const selection = (parsed.provider !== undefined && parsed.model !== undefined)
        ? { provider: parsed.provider, model: parsed.model }
        : resolveSelection()
      if (selection === undefined) {
        throw new Error('translate-flow: no model route available; pass provider and model, or configure one')
      }

      const signal = exec && exec.signal
      const results = []
      let carry = parsed.text
      for (let index = 0; index < parsed.steps.length; index += 1) {
        const step = parsed.steps[index]
        const spec = admitRun({
          runId: `tool-step-${index + 1}`,
          moduleId: step.moduleId,
          prompt: step.prompt,
          input: carry,
        })
        const record = { cancelled: false, timedOut: false, controller: new AbortController() }
        const forward = () => {
          record.cancelled = true
          record.controller.abort()
        }
        if (signal !== undefined && signal !== null) {
          if (signal.aborted) break
          signal.addEventListener('abort', forward, { once: true })
        }
        const startedAt = Date.now()
        try {
          const outcome = await runIsolatedModule(ctx.llm, selection, spec, record, timeoutMs)
          if (outcome.cancelled) break
          results.push({
            moduleId: spec.moduleId,
            prompt: spec.prompt,
            output: outcome.output,
            elapsedMs: Date.now() - startedAt,
            usage: outcome.usage ?? null,
          })
          carry = outcome.output
        } finally {
          signal?.removeEventListener('abort', forward)
        }
      }
      if (results.length !== parsed.steps.length) {
        throw new Error(`translate-flow: the call was cancelled after ${results.length} of ${parsed.steps.length} steps`)
      }
      return { provider: selection.provider, model: selection.model, input: parsed.text, steps: results }
    },
  }
}

/** Plugin display name. */
export const name = 'translate-flow'

/** Services this plugin needs before it may run. */
export const inject = ['llm', 'typert']

/**
 * Register the flow service.
 *
 * The service is an ordinary object rather than a Cordis `Service` subclass
 * only because importing that base class is impossible from a profile-local
 * plugin; the gateway validates the binding shape, not the prototype chain.
 * @param ctx - the plugin context carrying `llm`.
 * @param config - the loader row's config, optionally `{ provider, model, timeoutMs }`.
 */
export function apply(ctx, config) {
  /** Durable default route from the loader row; `undefined` means "use the agent default". */
  const configRoute = routeFromConfig(config)
  /** Per-call budget; the row may raise or lower it within the documented bounds. */
  const timeoutMs = timeoutFromConfig(config)

  /**
   * In-flight runs by id.
   *
   * Holding the record rather than the controller is what lets a cancellation
   * be distinguished from a timeout after the fact — the panel must not report
   * "stopped" as "failed".
   */
  const activeRuns = new Map()

  const service = {
    /**
     * Run one module as an isolated call.
     * @param request - `{ runId, moduleId, prompt, input, provider?, model? }`.
     * @returns the module's output plus what was sent and how long it took.
     */
    async runModule(request) {
      const spec = admitRun(request)
      if (activeRuns.has(spec.runId)) {
        throw new Error(`translate-flow: runId ${JSON.stringify(spec.runId)} is already running`)
      }

      const selection = (spec.provider !== undefined && spec.model !== undefined)
        ? { provider: spec.provider, model: spec.model }
        : (configRoute ?? defaultSelection(ctx))
      if (selection === undefined) {
        throw new Error('translate-flow: no model route available; pick a model in 模型配置 or configure one')
      }

      const record = { cancelled: false, timedOut: false, controller: new AbortController() }
      activeRuns.set(spec.runId, record)
      const startedAt = Date.now()
      try {
        const outcome = await runIsolatedModule(ctx.llm, selection, spec, record, timeoutMs)
        return {
          runId: spec.runId,
          moduleId: spec.moduleId,
          output: outcome.output,
          cancelled: outcome.cancelled,
          provider: selection.provider,
          model: selection.model,
          elapsedMs: Date.now() - startedAt,
          isolation: outcome.isolation,
          // One field, and the panel can show what the call cost.
          usage: outcome.usage ?? null,
        }
      } finally {
        // Only drop the record if it is still ours: a second run that reused the
        // id after this one finished must not have its record deleted here.
        if (activeRuns.get(spec.runId) === record) activeRuns.delete(spec.runId)
      }
    },

    /**
     * Abort an in-flight run.
     *
     * Cancelling is a resource action, not a content one: it can stop a call,
     * but it cannot change what any call sends.
     * @param request - `{ runId }`.
     * @returns whether a run with that id was in flight.
     */
    cancelRun(request) {
      const runId = admitCancel(request)
      const record = activeRuns.get(runId)
      if (record === undefined) return { runId, cancelled: false }
      record.cancelled = true
      record.controller.abort()
      return { runId, cancelled: true }
    },

    /**
     * Describe the built-in modules so the panel can seed its candidate cards
     * with the exact prompts the host will accept. Exposing them is a deliberate
     * transparency feature: the panel's editor starts from host truth rather
     * than from a copy that could drift.
     * @returns the module roster, the limits, and the default flow.
     */
    describe() {
      return {
        modules: BUILTIN_MODULES.map((module) => ({
          id: module.id,
          name: module.name,
          nameEn: module.nameEn,
          from: module.from,
          to: module.to,
          prompt: module.prompt,
        })),
        precisionFlow: PRECISION_FLOW.slice(),
        allowedRunKeys: ALLOWED_RUN_KEYS.slice(),
        limits: {
          maxInputChars: MAX_INPUT_CHARS,
          maxPromptChars: MAX_PROMPT_CHARS,
          maxIdChars: MAX_ID_CHARS,
          timeoutMs,
          temperature: RUN_TEMPERATURE,
          maxTokens: RUN_MAX_TOKENS,
        },
      }
    },

    /**
     * List every provider route and the models it advertises, so the panel can
     * offer the choice that a session-less call needs.
     *
     * One unreachable provider must not sink the whole list, so each model query
     * is isolated and degrades to an empty model list.
     * @returns the provider roster plus the route currently in force.
     */
    async listRoutes() {
      const llm = ctx.llm
      const providers = typeof llm.listProviders === 'function' ? (llm.listProviders() ?? []) : []
      // Queried in parallel: a slow provider must cost one budget, not one budget
      // per registered provider, or the panel's own ceiling expires on a roster
      // that was perfectly resolvable.
      const settled = await Promise.all(providers.map(async (info) => {
        const id = info && info.id
        if (!isNonEmptyString(id)) return undefined
        const listed = await withTimeout(Promise.resolve().then(() => llm.listModels(id)), MODEL_QUERY_TIMEOUT_MS)
        const models = listed.ok && Array.isArray(listed.value)
          ? listed.value
            .filter((model) => model && isNonEmptyString(model.id))
            .map((model) => ({ id: String(model.id), name: String(model.name ?? model.id) }))
          : []
        // 'ok' | 'timeout' | 'error': the panel can then say which provider was
        // slow instead of presenting it as a provider with no models.
        return { id, name: String((info && info.name) || id), models, status: listed.ok ? 'ok' : listed.reason }
      }))
      return {
        providers: settled.filter((entry) => entry !== undefined),
        current: configRoute ?? defaultSelection(ctx) ?? null,
      }
    },
  }

  // The binding the Gateway's host half reads: `service` must be the receiver
  // itself, `serviceKey` the Cordis key, `namespace` the wire namespace.
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: NAMESPACE }),
    enumerable: true,
  })

  const provide = typeof ctx.provide === 'function'
    ? ctx.provide.bind(ctx)
    : ctx.reflect.provide.bind(ctx.reflect)
  const disposeService = provide(SERVICE_KEY, service)

  // The panel is not the only caller that should be able to translate: the agent
  // gets the same isolated chain through one tool. A host without a tool registry
  // still activates the panel, so this is guarded rather than assumed.
  // Read through `ctx.get`, the documented optional-access route: reading a
  // service property that is not in `inject` throws, and declaring `tools` as a
  // hard dependency would mean no panels at all on a host without a registry —
  // the opposite of what an optional capability should cost.
  let disposeTool
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools !== undefined && tools !== null && typeof tools.register === 'function') {
    try {
      disposeTool = tools.register(
        defineTranslateTool(ctx, () => configRoute ?? defaultSelection(ctx), timeoutMs, service),
      )
    } catch {
      // A registry that refuses the name must not cost the panel.
      disposeTool = undefined
    }
  }

  // Return the disposer, so the registration is owned by this plugin's effect as
  // the authoring guide requires of every resource registered inside `apply`.
  return () => {
    if (typeof disposeTool === 'function') disposeTool()
    if (typeof disposeService === 'function') disposeService()
  }
}
