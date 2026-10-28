# dsh-plugin-translate-flow

严格隔离、可自定义的翻译流程插件，用于
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

插件暴露两个页面：

- **翻译流程** —— 输入节点、可拖拽的模块卡片、每个模块后自动生成输出节点、按顺序逐步执行并高亮进度。
- **翻译模型配置** —— 默认模型、内置模块提示词、自定义模块、导入导出，以及隔离说明。

内置模块：中译英、英译中、学术中文润色、学术英文润色。默认为精译链：

```
EN input -> 英译中 -> 学术中文润色 -> 中译英
```

每个模块都是独立的模型调用，只携带自己的提示词与自己的输入；执行严格隔离。

## 英文名称

社区展示名称：**Translation Flow**（翻译流程）。

## 隔离是"测出来的"，不是"声称的"

每个模块的调用只在 `lib/index.js` 的 `runIsolatedModule` 一处组装：

- `system` 就是本模块的提示词，不拼接任何其它内容；
- `messages` 是全新的单元素历史，只装本模块的输入；
- 不带 `tools`、`toolHistory`、`sessionId`、`purpose`；
- options 被冻结，`llm/stream` 的监听者无法在派发途中改写它。

面板里那些隔离徽章，数字取自真正交给 `llm.stream` 的 options 对象，因此会随请求变化，
而不是重复一句口号。

## 模型路由

三档，按顺序：

1. 模块自己的 provider/model 覆写；
2. loader 行 `config: { provider, model }`；
3. 会话默认 agent 模型。

按会话路由的 OpenCode 风格 provider（需要 `x-opencode-session` 请求头）不支持这种故意无会话的调用；
请使用普通的 Messages / OpenAI 兼容 provider。

### 单次调用超时

默认每个模块 300 秒。可由 loader 行覆盖：

```yaml
- id: translate-flow
  config:
    provider: <provider>
    model: <model>
    timeoutMs: 120000   # 1 秒 ~ 10 分钟，超出范围的值会被忽略
```

超时由两道机制保证：abort 信号请求 provider 停止，`consumeStream` 内的截止时间则停止**等待**。
因此一个既不产出、又无视信号的 provider 会被如实报告为超时，而不是一直占着 `runId`；
取消这类运行也会立即返回。

## Agent 工具

同一条隔离链也暴露为 agent 工具 `translate_flow`：每步一次调用、不附加会话；
省略 `steps` 即运行内置精译链。仅在宿主提供工具注册表时注册，没有该服务的宿主仍能正常激活面板。

## Token 用量

当 provider 回报 token 用量时，每个模块的结果会带上它；查看器「信息」页会在隔离记录旁
显示提示词/输入规模、token 数与耗时。

## 兼容性

- DeepSeek Harness **0.2.0-rc.2**（桌面端）已验证。
- Node.js **>=18**。
- 无额外 npm 运行时依赖；宿主提供 React 运行时。

## 安装

安装为 bundle（包会声明自己的 patch，插入 loader 行）：

```
dsh plugin --profile <name> add dsh-plugin-translate-flow
```

对于应用自有 profile（如 Desktop），可以在插件管理器中传入包绝对目录进行应用内安装。

随后会出现两个侧边栏条目：**翻译流程** 与 **翻译模型配置**，各自对应自己的 `main` 面板。

宿主半侧的改动在进程生命周期内按包名缓存（Node 的 ESM 缓存与 Typert 清单缓存），
因此替换已安装的宿主半侧需要重启 DSH，或换一个新包名。

## 隐私与计费

由于调用不携带 `sessionId`，它们**不会进入会话日志**：

- 不会出现在会话转录中；
- 在 token 用量计费中不能归属到某个会话；
- 不会在按会话的仪表板中可见。

这是隔离设计的直接后果，是真实权衡，不是疏忽。要可审计的用量，请不要为此使用本插件。
你翻译的文本会发送到你所选的 provider，与 agent 自身调用完全一致。

## 发布与自检

```
node test/host.test.mjs      # 114 条断言
node test/manifest.test.mjs  #  95 条断言
node test/client.test.mjs    #  63 条断言
```

共 272 条断言，覆盖隔离契约、导入/手改文档可能造成的图修复边界、agent 工具返回值的
声明形状校验、截止时间与取消行为、token 用量路径、三个面共享的标识符，以及两个页面的一次真实渲染。

发布前请确认：

- [ ] `dsh.bundle.patch` 指向的文件存在且语法正确
- [ ] `cordis.patch.yml` 中插件行按包名引用
- [ ] `files` 字段包含全部运行时需要文件
- [ ] 三个测试文件全部通过
- [ ] README / README.zh.md / LICENSE / icon / locale 完整

社区发布 additional topics：`dsh-plugin`、`deepseek-harness`、`dsh`、`cordis`。

## 许可

MIT — 见 [LICENSE](LICENSE)。
