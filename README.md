# dsh-plugin-translate-flow

Isolated, customizable translation flow for DeepSeek Harness.

The plugin exposes one page:

- **翻译流程 / Translation Flow** — input node, draggable module cards, an output
  node after every module, and sequential execution with progress highlighting.
  Each module's prompt and model are edited in place, from that module's card.

Built-in modules: 中译英, 英译中, 学术中文润色, 学术英文润色. The default mode is the
precision chain:

```
EN input -> 英译中 -> 学术中文润色 -> 中译英
```

Every module is a separate model call carrying only its own prompt and its own
input; execution is strictly isolated.

## Presets

Two buttons in the page header replace the chain with a precision round trip:

- **汉语精译 / Chinese precision** — `zh2en -> en-academic -> en2zh`
- **英文精译 / English precision** — `en2zh -> zh-academic -> zh2en`

Each one translates out of the source language, polishes in the target language
and translates back, so what the polish did is visible. 英文精译 is also the chain
a fresh panel starts from, and the chain the agent tool runs when `steps` is
omitted. A preset is a starting point rather than a mode: the modules it places
are ordinary modules, editable and removable like any other.

## English name

Published community display name: **Translation Flow**.

## Isolation, measured rather than asserted

Each module call is assembled in one place (`runIsolatedModule` in `lib/index.js`)
and carries:

- `system` — the module's own prompt, with nothing concatenated onto it;
- `messages` — a fresh one-element history holding exactly this module's input;
- no `tools`, no `toolHistory`, no `sessionId`, no `purpose`;
- a frozen options object, so an `llm/stream` listener cannot rewrite it in flight.

The isolation badges in the viewer are read off the object handed to
`llm.stream`, so the numbers follow the request rather than restating a claim.

## Model routing

Three tiers, in order:

1. the module's own provider/model override — editable on each module's card;
2. the loader row `config: { provider, model }` — no panel control: set it in the
   loader row if you want a durable default that is not the session's model;
3. the session's default agent model.

OpenCode-style providers requiring a per-conversation `x-opencode-session` header
are not supported by the deliberately session-less calls; use a plain
Messages/OpenAI-compatible provider.

### Per-call timeout

The default budget is 300 s per module call. A loader row may override it:

```yaml
- id: translate-flow
  config:
    provider: <provider>
    model: <model>
    timeoutMs: 120000   # 1 s .. 10 min; anything else is ignored
```

The budget is enforced twice: the abort signal asks the provider to stop, and a
deadline inside `consumeStream` stops *waiting*. A provider that never yields and
ignores the signal is therefore reported as a timeout instead of holding the run
and reserving its `runId` forever, and cancelling such a run resolves at once.

## Agent tool

The same isolated chain is reachable by the agent as the `translate_flow` tool:
one call per step, no session attached, and omitting `steps` runs the built-in
precision chain. It is registered only when the host exposes a tool registry, so
a host without one still activates the panels.

## Token usage

When a provider reports token accounting, each module's result carries it and the
viewer's **info** tab shows prompt/input sizes, token counts and elapsed time
beside the isolation record.

## Compatibility

- DeepSeek Harness **0.2.0-rc.2** (desktop) tested.
- Node.js **>=18**.
- No extra runtime npm dependencies; React is provided by the host.

## Install

Install as a bundle (the package declares its own patch, which inserts its loader
row):

```
dsh plugin --profile <name> add dsh-plugin-translate-flow
```

For an application-owned profile (such as the Desktop one), install in-app with
the plugin manager, passing the absolute package directory as the target.

The page then appears as the sidebar entry **翻译流程 / Translation Flow**,
addressing its own `main` panel.

Host-half changes are cached by package name for the life of the process (both
Node's ESM module cache and the Typert manifest cache), so replacing an installed
host half needs a DSH restart or a new package name.

## Privacy and accounting

Because the calls carry no `sessionId`, they **are not part of the session log**:

- they do not appear in the session transcript;
- they are not attributable to a session in token-usage accounting;
- they are not visible in per-session dashboards.

This is a direct consequence of the isolation design — a real trade-off, not an
oversight. To keep auditable usage, do not use this plugin for it. The text you
translate does go to whichever provider you selected, exactly as it would from
the agent itself.

## Verification

```
node test/host.test.mjs      # 120 assertions
node test/manifest.test.mjs  # 101 assertions
node test/client.test.mjs    #  56 assertions
```

277 assertions covering the isolation contract, the two presets and the flows
they build, the graph-repair edge cases a hand-edited or imported document can
produce, the declared-shape check on the agent tool's own result, deadline and
cancellation behaviour, the token-usage path, the identifiers shared by the
three faces, and a one-pass render of the page.

## Publishing checklist

- [ ] `dsh.bundle.patch` points at a file that exists and parses
- [ ] `cordis.patch.yml` names the package in its loader row
- [ ] `files` lists everything the runtime needs
- [ ] all three test files pass
- [ ] README / README.zh.md / LICENSE / icon / locale are current

Community topics: `dsh-plugin`, `deepseek-harness`, `dsh`, `cordis`.

## License

MIT — see [LICENSE](LICENSE).
