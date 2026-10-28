/**
 * Hand-written Typert manifest for this plugin's host half.
 *
 * DSH ships a Typert *generator* that emits this file for first-party packages.
 * Because this plugin is built out of tree, the manifest is written by hand and
 * mirrors the generator's output shape, so the standard
 * `@deepseek-ai/dsh-typert-loader` discovery picks it up through the package's
 * `./typert` export with no special casing.
 *
 * The manifest declares four direct Remote methods on the `translateFlowPanel`
 * service, reachable from the browser as `ctx.remote.translateFlow.<method>`:
 *
 *   - `runModule`  - one isolated module call, with its token usage
 *   - `cancelRun`  - abort an in-flight module call
 *   - `describe`   - the built-in module roster, limits and default flow
 *   - `listRoutes` - the provider/model roster behind the pickers
 *
 * The agent-facing `translate_flow` tool is deliberately absent here: it is not
 * a Remote method. `lib/index.js` registers it with the host's tool registry,
 * so it needs a `ToolDefinition` rather than a wire descriptor.
 *
 * ## Why the codecs are hand-rolled
 *
 * The generated manifest imports `zod`. A profile-local plugin cannot resolve
 * DSH's packages (and `zod` with them) from the profile's shared `node_modules`,
 * so an import here would fail activation for the whole entry. The gateway only
 * ever needs three things from a strict codec:
 *
 *   - `mode === 'strict'`, checked at registration and again at the boundary;
 *   - for inputs, `codec.create().parse(value)` -- the host calls `parse`;
 *   - for results, an *optional* `codec.encode`; when absent the gateway ships
 *     the value as-is.
 *
 * Plain objects supplying `parse` therefore satisfy the contract exactly, and
 * the request validators deliberately return the caller's object unchanged so
 * that the service's own `admitRun` -- not a silent field-dropping schema -- is
 * what rejects a smuggled field, and with a readable message.
 *
 * @module dsh-plugin-translate-flow/typert
 */

const PACKAGE = 'dsh-plugin-translate-flow'
const TYPE_BASE = `${PACKAGE}/types`

/** @returns true for a non-array object. */
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate a run request's shape without dropping fields.
 *
 * Only the coarsest checks live here -- the service's `admitRun` owns the exact
 * field list and the readable rejections. This one exists so a malformed
 * payload fails at the wire boundary instead of inside the service.
 * @returns the caller's object, unchanged.
 */
function parseRunRequest(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: request must be an object')
  if (typeof value.runId !== 'string') throw new TypeError('translate-flow: request.runId must be a string')
  if (typeof value.moduleId !== 'string') throw new TypeError('translate-flow: request.moduleId must be a string')
  if (typeof value.prompt !== 'string') throw new TypeError('translate-flow: request.prompt must be a string')
  if (typeof value.input !== 'string') throw new TypeError('translate-flow: request.input must be a string')
  if (value.provider !== undefined && typeof value.provider !== 'string') {
    throw new TypeError('translate-flow: request.provider must be a string when present')
  }
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new TypeError('translate-flow: request.model must be a string when present')
  }
  return value
}

/** Validate a cancel request; like the run request, pass it through unchanged. */
function parseCancelRequest(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: cancel must be an object')
  if (typeof value.runId !== 'string') throw new TypeError('translate-flow: cancel.runId must be a string')
  return value
}

/** Validate a module run result. */
function parseRunResult(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: result must be an object')
  for (const field of ['runId', 'moduleId', 'output', 'provider', 'model']) {
    if (typeof value[field] !== 'string') {
      throw new TypeError(`translate-flow: result.${field} must be a string`)
    }
  }
  if (typeof value.cancelled !== 'boolean') throw new TypeError('translate-flow: result.cancelled must be a boolean')
  if (typeof value.elapsedMs !== 'number') throw new TypeError('translate-flow: result.elapsedMs must be a number')
  if (!isPlainRecord(value.isolation)) throw new TypeError('translate-flow: result.isolation must be an object')
  // `usage` is optional: not every provider reports token accounting, and a call
  // without it is still a successful call.
  if (value.usage !== undefined && value.usage !== null) {
    if (!isPlainRecord(value.usage)) throw new TypeError('translate-flow: result.usage must be an object or null')
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
      const tokens = value.usage[field]
      if (tokens !== undefined && tokens !== null && typeof tokens !== 'number') {
        throw new TypeError(`translate-flow: result.usage.${field} must be a number when present`)
      }
    }
  }
  return value
}

/** Validate a cancel result. */
function parseCancelResult(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: cancel result must be an object')
  if (typeof value.runId !== 'string') throw new TypeError('translate-flow: cancel result.runId must be a string')
  if (typeof value.cancelled !== 'boolean') {
    throw new TypeError('translate-flow: cancel result.cancelled must be a boolean')
  }
  return value
}

/** Validate the module roster. */
function parseDescribeResult(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: describe result must be an object')
  if (!Array.isArray(value.modules)) throw new TypeError('translate-flow: describe result.modules must be an array')
  for (const module of value.modules) {
    if (!isPlainRecord(module)) throw new TypeError('translate-flow: each described module must be an object')
    for (const field of ['id', 'name', 'prompt']) {
      if (typeof module[field] !== 'string') {
        throw new TypeError(`translate-flow: described module.${field} must be a string`)
      }
    }
  }
  if (!Array.isArray(value.precisionFlow)) {
    throw new TypeError('translate-flow: describe result.precisionFlow must be an array')
  }
  for (const id of value.precisionFlow) {
    if (typeof id !== 'string') throw new TypeError('translate-flow: precisionFlow entries must be strings')
  }
  // Optional, so a panel whose client half is newer than this host still mounts.
  if (value.presets !== undefined) {
    if (!Array.isArray(value.presets)) throw new TypeError('translate-flow: describe result.presets must be an array')
    for (const preset of value.presets) {
      if (!isPlainRecord(preset)) throw new TypeError('translate-flow: each preset must be an object')
      for (const field of ['id', 'name']) {
        if (typeof preset[field] !== 'string') throw new TypeError(`translate-flow: preset.${field} must be a string`)
      }
      if (!Array.isArray(preset.flow)) throw new TypeError('translate-flow: preset.flow must be an array')
      for (const id of preset.flow) {
        if (typeof id !== 'string') throw new TypeError('translate-flow: preset.flow entries must be strings')
      }
    }
  }
  if (!Array.isArray(value.allowedRunKeys)) {
    throw new TypeError('translate-flow: describe result.allowedRunKeys must be an array')
  }
  if (!isPlainRecord(value.limits)) throw new TypeError('translate-flow: describe result.limits must be an object')
  return value
}

/** Validate the provider roster. */
function parseRoutesResult(value) {
  if (!isPlainRecord(value)) throw new TypeError('translate-flow: listRoutes result must be an object')
  if (!Array.isArray(value.providers)) throw new TypeError('translate-flow: listRoutes result.providers must be an array')
  for (const provider of value.providers) {
    if (!isPlainRecord(provider)) throw new TypeError('translate-flow: each listed provider must be an object')
    if (typeof provider.id !== 'string') throw new TypeError('translate-flow: listed provider.id must be a string')
    if (typeof provider.name !== 'string') throw new TypeError('translate-flow: listed provider.name must be a string')
    if (provider.status !== undefined && !['ok', 'timeout', 'error'].includes(provider.status)) {
      throw new TypeError('translate-flow: listed provider.status must be ok, timeout or error when present')
    }
    if (!Array.isArray(provider.models)) throw new TypeError('translate-flow: listed provider.models must be an array')
    for (const model of provider.models) {
      if (!isPlainRecord(model)) throw new TypeError('translate-flow: each listed model must be an object')
      if (typeof model.id !== 'string') throw new TypeError('translate-flow: listed model.id must be a string')
      if (typeof model.name !== 'string') throw new TypeError('translate-flow: listed model.name must be a string')
    }
  }
  if (value.current !== null) {
    if (!isPlainRecord(value.current)) {
      throw new TypeError('translate-flow: listRoutes result.current must be an object or null')
    }
    if (typeof value.current.provider !== 'string') {
      throw new TypeError('translate-flow: current.provider must be a string')
    }
    if (typeof value.current.model !== 'string') {
      throw new TypeError('translate-flow: current.model must be a string')
    }
  }
  return value
}

/** Build a strict codec around one `parse` implementation. */
function codec(typeSymbol, schemaFactory) {
  return { mode: 'strict', typeSymbol, create: schemaFactory }
}

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: `${PACKAGE}#translateFlow/runModule`,
      service: 'translateFlowPanel',
      namespace: 'translateFlow',
      method: 'runModule',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: codec(`${TYPE_BASE}#FlowRunRequest`, () => ({ parse: parseRunRequest })),
        },
      ],
      result: codec(`${TYPE_BASE}#FlowRunResult`, () => ({ parse: parseRunResult })),
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
    {
      id: `${PACKAGE}#translateFlow/cancelRun`,
      service: 'translateFlowPanel',
      namespace: 'translateFlow',
      method: 'cancelRun',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: codec(`${TYPE_BASE}#FlowCancelRequest`, () => ({ parse: parseCancelRequest })),
        },
      ],
      result: codec(`${TYPE_BASE}#FlowCancelResult`, () => ({ parse: parseCancelResult })),
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
    {
      id: `${PACKAGE}#translateFlow/describe`,
      service: 'translateFlowPanel',
      namespace: 'translateFlow',
      method: 'describe',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec(`${TYPE_BASE}#FlowDescribeResult`, () => ({ parse: parseDescribeResult })),
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
    {
      id: `${PACKAGE}#translateFlow/listRoutes`,
      service: 'translateFlowPanel',
      namespace: 'translateFlow',
      method: 'listRoutes',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec(`${TYPE_BASE}#FlowRoutesResult`, () => ({ parse: parseRoutesResult })),
      sourceLocation: { file: 'lib/index.js', line: 1, column: 1 },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}

export default TYPERT
