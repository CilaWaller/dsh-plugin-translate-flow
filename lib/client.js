/**
 * Browser half of the custom translation flow.
 *
 * This file is a hand-authored plugin bundle: plain JavaScript wrapped in the
 * loader's CJS-factory envelope, requesting only `react` from the platform
 * module table. It registers one shell page:
 *
 *   - `translate-flow` — the flow page: a node chain plus a viewer.
 *
 * ## The graph
 *
 * The chain is a flat, ordered node list:
 *
 *     input, module, output, module, output, ...
 *
 * `input` and `output` nodes are never authored by hand. Dropping a module onto
 * a drop target inserts the module *and* the output node that follows it, so the
 * chain always reads "…produced this, then that". Removing a module removes its
 * output node with it, and moving a module moves the pair.
 *
 * ## Isolation
 *
 * The flow runs one host call per module and nothing else. Each call carries
 * `{ runId, moduleId, prompt, input, provider?, model? }` — the module's own
 * prompt and its own input, and no field through which one module's context
 * could reach another. The chain lives here, in the panel; the host keeps seeing
 * one isolated call at a time.
 *
 * The one thing that crosses a boundary is the previous module's output *text*,
 * which is passed as the next module's `input`. That is the whole contract, and
 * the viewer shows the host's own `isolation` summary for the selected module so
 * the claim is checkable rather than asserted.
 *
 * ## Persistence
 *
 * Module definitions, per-module prompt overrides, the default route and the
 * graph shape are kept in this browser profile's `localStorage`. **User text is
 * never persisted**: input, per-module input and every output are stripped
 * before the graph is written, so the flow survives a reload without leaving a
 * translation behind.
 *
 * @module dsh-plugin-translate-flow/client
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-translate-flow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef } = React;

		/** Sidebar entry id and `main` slot key for the flow page. */
		const PANEL_FLOW = "translate-flow";
		/** Sidebar entry id and `main` slot key for the configuration page. */
		const PANEL_CONFIG = "translate-flow-config";
		/** `localStorage` key holding the saved document. */
		const STORAGE_KEY = "dsh-plugin-translate-flow:v1";
		/** Separator for provider/model pairs inside one `<option>` value. */
		const ROUTE_SEP = "\u0000";
		/** Document schema version; a mismatch is discarded rather than guessed at. */
		const DOC_VERSION = 1;
		/** Most custom modules a document may hold; enforced on read and on write. */
		const MAX_CUSTOM_MODULES = 50;

		/**
		 * Local fallback copy of the built-in modules.
		 *
		 * The host's `describe` is authoritative and is what the panel normally
		 * renders; this copy exists so a panel whose host half is older than its
		 * client half still shows usable candidate cards instead of an empty grid.
		 */
		const FALLBACK_MODULES = [
			{
				id: "zh2en",
				name: "中译英",
				nameEn: "ZH → EN",
				from: "Chinese",
				to: "English",
				prompt: "You are a professional Chinese-to-English translator. Translate the user's text into natural, idiomatic English while preserving meaning, names and numbers. Output only the translation.",
			},
			{
				id: "en2zh",
				name: "英译中",
				nameEn: "EN → ZH",
				from: "English",
				to: "Chinese",
				prompt: "You are a professional English-to-Simplified-Chinese translator. Translate the user's text faithfully and completely. Preserve names, numbers and formatting. Output only the translation.",
			},
			{
				id: "zh-academic",
				name: "学术中文润色",
				nameEn: "Academic Chinese polish",
				from: "Chinese",
				to: "Chinese",
				prompt: "你是资深中文学术编辑。请将用户提供的中文文本润色为自然、流畅、地道的学术中文表达，保持原意、事实、数字和专有名词不变，不增删信息。只输出润色后的中文文本。",
			},
			{
				id: "en-academic",
				name: "学术英文润色",
				nameEn: "Academic English polish",
				from: "English",
				to: "English",
				prompt: "You are a professional academic English editor. Polish the user's English text for clarity, flow and academic tone while preserving meaning, facts, names and numbers. Output only the polished text.",
			},
		];

		/** The 精译 chain, used when the host does not name one. */
		const FALLBACK_PRECISION_FLOW = ["en2zh", "zh-academic", "zh2en"];

		/** Host Remote contribution this plugin mounts for itself. */
		const REMOTE_CONTRIBUTION = {
			package: "dsh-plugin-translate-flow",
			descriptors: [
				{
					id: "dsh-plugin-translate-flow#translateFlow/runModule",
					service: "translateFlowPanel",
					namespace: "translateFlow",
					method: "runModule",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "request",
							wire: "request",
							source: "json",
							codec: strictCodec("dsh-plugin-translate-flow/types#FlowRunRequest"),
						},
					],
					result: strictCodec("dsh-plugin-translate-flow/types#FlowRunResult"),
				},
				{
					id: "dsh-plugin-translate-flow#translateFlow/cancelRun",
					service: "translateFlowPanel",
					namespace: "translateFlow",
					method: "cancelRun",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "request",
							wire: "request",
							source: "json",
							codec: strictCodec("dsh-plugin-translate-flow/types#FlowCancelRequest"),
						},
					],
					result: strictCodec("dsh-plugin-translate-flow/types#FlowCancelResult"),
				},
				{
					id: "dsh-plugin-translate-flow#translateFlow/describe",
					service: "translateFlowPanel",
					namespace: "translateFlow",
					method: "describe",
					invocation: { kind: "direct" },
					parameters: [],
					result: strictCodec("dsh-plugin-translate-flow/types#FlowDescribeResult"),
				},
				{
					id: "dsh-plugin-translate-flow#translateFlow/listRoutes",
					service: "translateFlowPanel",
					namespace: "translateFlow",
					method: "listRoutes",
					invocation: { kind: "direct" },
					parameters: [],
					result: strictCodec("dsh-plugin-translate-flow/types#FlowRoutesResult"),
				},
			],
		};

		/**
		 * Client-side codecs.
		 *
		 * The gateway validates that every generated codec is `strict` but never
		 * calls `create()` in the browser; the host validates payloads against the
		 * real schemas in `lib/typert.host.js`. A passthrough factory therefore
		 * satisfies the client contract without shipping a validator library.
		 */
		function strictCodec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				create: () => ({ parse: (value) => value }),
			};
		}

		// ── theme ────────────────────────────────────────────────────────────
		// Alias tokens published by @deepseek-ai/dsh-client-ui-theme, so the panel
		// follows light and dark without knowing which is active.
		const C = {
			bg: "var(--dsw-alias-bg-base)",
			layer1: "var(--dsw-alias-bg-layer-1)",
			layer2: "var(--dsw-alias-bg-layer-2)",
			border1: "var(--dsw-alias-border-l1)",
			border2: "var(--dsw-alias-border-l2)",
			brand: "var(--dsw-alias-brand-primary)",
			text: "var(--dsw-alias-label-primary)",
			textDim: "var(--dsw-alias-label-secondary)",
			textFaint: "var(--dsw-alias-label-tertiary)",
			error: "var(--dsw-alias-state-error-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			idle: "var(--dsw-alias-state-idle-primary)",
		};

		/** Injected once per activation: the only animation the panel needs. */
		const CSS_TAG_ID = "dsh-plugin-translate-flow/api.css";
		const CSS_TEXT = [
			"@keyframes dsh-tf-breathe{0%,100%{opacity:1}50%{opacity:.5}}",
			".dsh-tf-running{animation:dsh-tf-breathe 1.3s ease-in-out infinite}",
			"@media (prefers-reduced-motion: reduce){.dsh-tf-running{animation:none}}",
		].join("");

		/** Install the panel's keyframes, returning a disposer for the tag. */
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-translate-flow";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
			return () => {
				try {
					tag.remove();
				} catch {
					/* already detached */
				}
			};
		}

		// ── layout tokens ────────────────────────────────────────────────────
		const panelStyle = {
			height: "100%",
			boxSizing: "border-box",
			overflow: "hidden",
			background: C.bg,
			color: C.text,
			padding: "10px 14px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 8,
			minHeight: 0,
		};

		const cardStyle = {
			display: "flex",
			flexDirection: "column",
			minHeight: 0,
			background: C.layer1,
			border: `1px solid ${C.border1}`,
			borderRadius: 9,
			overflow: "hidden",
		};

		const cardHeadStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap",
			padding: "6px 10px",
			borderBottom: `1px solid ${C.border1}`,
			fontSize: 12,
			minHeight: 28,
			boxSizing: "border-box",
		};

		const cardBodyStyle = {
			flex: "1 1 auto",
			minHeight: 0,
			overflow: "auto",
			padding: 8,
			display: "flex",
			flexDirection: "column",
			gap: 6,
		};

		const sectionTitleStyle = { fontSize: 12, fontWeight: 600, color: C.text };
		const hintStyle = { fontSize: 10.5, color: C.textFaint };
		const labelStyle = { fontSize: 11, color: C.textDim, marginBottom: 3, display: "block" };

		const fieldStyle = {
			width: "100%",
			boxSizing: "border-box",
			background: C.layer2,
			color: C.text,
			border: `1px solid ${C.border2}`,
			borderRadius: 6,
			padding: "4px 7px",
			font: "inherit",
			fontSize: 12,
			lineHeight: 1.5,
			outline: "none",
		};

		const monoStyle = { ...fieldStyle, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 };

		/** A flexing read-only/writable text box. */
		const textAreaStyle = {
			...fieldStyle,
			flex: "1 1 auto",
			minHeight: 60,
			resize: "none",
			fontSize: 13,
			lineHeight: 1.6,
		};

		const selectStyle = { ...fieldStyle, cursor: "pointer", maxWidth: 280 };

		/** A chip: small, coloured, non-interactive. */
		function chipStyle(color) {
			return {
				fontSize: 10,
				padding: "0 6px",
				borderRadius: 999,
				border: `1px solid ${color}`,
				color,
				whiteSpace: "nowrap",
				lineHeight: "16px",
			};
		}

		function buttonStyle(variant, enabled) {
			const base = {
				border: `1px solid ${C.border2}`,
				borderRadius: 6,
				padding: "3px 9px",
				font: "inherit",
				fontSize: 11.5,
				lineHeight: 1.5,
				cursor: enabled ? "pointer" : "not-allowed",
				opacity: enabled ? 1 : 0.45,
				background: "transparent",
				color: C.text,
				whiteSpace: "nowrap",
			};
			if (variant === "primary" && enabled) {
				base.background = C.brand;
				base.border = `1px solid ${C.brand}`;
				base.color = C.bg;
				base.fontWeight = 600;
				base.padding = "4px 14px";
				base.fontSize = 12.5;
			}
			if (variant === "danger" && enabled) {
				base.border = `1px solid ${C.error}`;
				base.color = C.error;
			}
			return base;
		}

		// ── locale ───────────────────────────────────────────────────────────
		/** Locale namespace for this plugin's own UI strings. */
		const LOCALE_NS = "translate-flow";

		/**
		 * Message catalogues.
		 *
		 * `zh` is also the fallback table: if the locale service is missing or its
		 * API differs in a future build, the panel renders Chinese instead of
		 * blanking out, so a locale problem degrades text and never the view.
		 */
		const MESSAGES = {
			zh: {
				"panel.status.running": "运行中",
				"panel.status.error": "失败",
				"panel.status.done": "完成",
				"panel.status.idle": "等待",
				"panel.notReady": "正在读取宿主信息…",

				"nav.flow": "翻译流程",
				"nav.config": "翻译模型配置",
				"flow.title": "自定义翻译流程",
				"flow.subtitle": "拖入模块组成链路，系统自动补全输入 / 输出节点并依次执行",
				"flow.chainTitle": "流程链路",
				"flow.chainHint": "把右侧模块拖到虚线框内",
				"flow.chainEmpty": "链路里还没有模块。从右侧「候选模块」拖一个过来，或直接点击卡片追加到末尾。",
				"flow.input": "输入",
				"flow.inputEmpty": "点击后在右下方输入原文",
				"flow.output": "输出 {n}",
				"flow.outputWaiting": "等待生成",
				"flow.chars": "{n} 字符",
				"flow.dropHere": "拖放模块到这里",
				"flow.dropActive": "松开以插入模块",
				"flow.appendHere": "拖到此处可追加到末尾",
				"flow.model": "模型",
				"flow.followDefault": "跟随默认模型",
				"flow.prompt": "提示词",
				"flow.remove": "移除模块",
				"flow.moveUp": "上移",
				"flow.moveDown": "下移",
				"flow.elapsed": "{s}s",

				"candidates.title": "候选模块",
				"candidates.hint": "拖到左侧节点下方，或点击追加到末尾",
				"candidates.builtin": "默认",
				"candidates.edit": "编辑模块",
				"candidates.delete": "删除自定义模块",
				"candidates.add": "自定义模块",
				"candidates.addHint": "自定义名称、提示词与模型",
				"candidates.customTag": "自定义",

				"viewer.inputTitle": "输入区域",
				"viewer.moduleTitle": "{name} · 输出",
				"viewer.outputTitle": "输出 {n}",
				"viewer.tab.output": "输出",
				"viewer.tab.input": "本模块输入",
				"viewer.tab.prompt": "提示词",
				"viewer.tab.info": "调用信息",
				"viewer.inputPlaceholder": "在此输入原文，然后点右上角「开始」",
				"viewer.outputPlaceholder": "等待生成",
				"viewer.moduleInputPlaceholder": "运行时这里会显示该模块实际收到的输入",
				"viewer.copy": "复制",
				"viewer.copied": "已复制",
				"viewer.isoTitle": "本次调用实际发送的内容",
				"viewer.isoMessages": "消息 {n} 条",
				"viewer.isoHistory": "历史 {n} 条",
				"viewer.isoTools": "工具 {n} 个",
				"viewer.isoSession": "会话：未附加",
				"viewer.isoSystemChars": "提示词 {n} 字符",
				"viewer.isoInputChars": "输入 {n} 字符",
				"viewer.isoUsage": "用量 {in} / {out} tokens",
				"viewer.inputLocked": "运行中，输入已锁定",
				"viewer.isoEmpty": "该模块还没有运行过，运行后这里会显示宿主回传的调用摘要。",
				"viewer.noSelection": "点击左侧节点查看内容",

				"editor.create": "新建自定义模块",
				"editor.edit": "编辑模块",
				"editor.builtinNote": "这是内置模块：修改会作为本机默认值保存，可随时恢复。",
				"editor.name": "模块名称",
				"editor.namePlaceholder": "例如：法律英语润色",
				"editor.model": "默认模型",
				"editor.prompt": "提示词",
				"editor.promptPlaceholder": "该模块的完整系统提示词；模型只会看到这段提示词加上本模块的输入",
				"editor.resetPrompt": "恢复内置提示词",
				"editor.save": "保存",
				"editor.cancel": "取消",
				"editor.delete": "删除",
				"editor.missingName": "请填写模块名称。",
				"editor.missingPrompt": "请填写提示词。",
				"editor.tooMany": "自定义模块最多 {n} 个。",

				"config.title": "翻译模型配置",
				"config.subtitle": "默认模型、内置模块的提示词与自定义模块都在这里管理",
				"config.defaultTitle": "默认模型",
				"config.defaultHint": "没有单独指定模型的模块会使用它；未设置时跟随当前会话的智能体模型。",
				"config.current": "当前宿主路由：{provider} / {model}",
				"config.agentDefault": "当前宿主路由：跟随会话默认模型",
				"config.test": "测试",
				"config.testing": "测试中…",
				"config.testOk": "调用成功：{provider} / {model}，耗时 {ms} ms",
				"config.builtinTitle": "内置模块",
				"config.builtinHint": "修改默认提示词或默认模型。留空的模型表示跟随上面的默认模型。",
				"config.customTitle": "自定义模块",
				"config.customHint": "自定义模块同样可以在流程页拖入使用。",
				"config.customEmpty": "还没有自定义模块。",
				"config.transferTitle": "配置迁移",
				"config.transferHint": "模块、提示词与默认模型保存在本机浏览器存储中；用户文本不会被保存。",
				"config.export": "导出 JSON",
				"config.import": "导入 JSON",
				"config.importApply": "应用导入",
				"config.importPlaceholder": "把导出的 JSON 粘贴到这里",
				"config.imported": "已导入配置。",
				"config.importFailed": "导入失败：JSON 无效。",
				"config.clearCustom": "清空自定义模块",
				"config.cleared": "已清空自定义模块。",
				"config.isolationTitle": "隔离说明",
				"config.isolationBody": "每个模块都是一次独立的模型调用：只发送该模块自己的提示词与输入，不发送会话历史、工具定义或其他模块的内容。模块之间唯一的传递物是上一个模块的输出文本。",
				"config.isolationKeys": "宿主只接受这些字段：{keys}",
				"config.limits": "限制：输入 ≤ {input} 字符，提示词 ≤ {prompt} 字符，单次调用超时 {timeout} 秒。",

				"route.loading": "加载模型中…",
				"route.none": "没有可用模型",
				"route.choose": "选择模型…",
				"route.noModels": "（无可选模型）",
				"route.unavailable": "模型列表不可用",
				"route.retry": "重试",
				"route.timeout": "模型列表查询超时",
				"route.hostMissing": "宿主半侧尚未提供模型列表，需要重启 DSH 才能加载新版本",
				"route.manual": "手动",
				"route.manualProvider": "provider",
				"route.manualModel": "model",
				"route.manualApply": "应用",
				"route.reload": "刷新模型列表",
				"route.providerTimeout": "（查询超时）",
				"route.providerError": "（不可用）",

				"action.start": "开始",
				"action.stop": "停止",
				"action.precision": "重置精译链",
				"action.clearFlow": "清空链路",
				"action.progress": "已完成 {done}/{total}",
				"action.progressDone": "已完成 {n} 步",

				"notice.emptyInput": "请先在输入区域填写原文。",
				"notice.noModules": "请先向链路中拖入至少一个模块。",
				"notice.done": "流程完成。",
				"notice.failed": "第 {n} 个模块失败，流程已停止。",
				"notice.cancelled": "已停止。",
				"notice.copyFailed": "复制失败，请手动选择文本。",
				"notice.precision": "已重置为精译链。",
				"notice.clearedFlow": "已清空链路。",
				"notice.added": "已添加模块「{name}」。",
				"notice.removed": "已移除模块。",
				"notice.routeSet": "已保存默认模型。",
				"notice.routeFallback": "模块未指定模型时使用默认模型。",
				"notice.notReady": "宿主半侧还没有就绪，请稍候或点「刷新模型列表」。",
			},
			en: {
				"panel.status.running": "Running",
				"panel.status.error": "Failed",
				"panel.status.done": "Done",
				"panel.status.idle": "Waiting",
				"panel.notReady": "Reading host state…",

				"nav.flow": "Translation flow",
				"nav.config": "Translation models",
				"flow.title": "Custom translation flow",
				"flow.subtitle": "Drag modules into the chain; input and output nodes are added for you and run in order",
				"flow.chainTitle": "Flow chain",
				"flow.chainHint": "Drag a module from the right into a dashed slot",
				"flow.chainEmpty": "The chain is empty. Drag a candidate module here, or click one to append it.",
				"flow.input": "Input",
				"flow.inputEmpty": "Click, then type the source in the viewer",
				"flow.output": "Output {n}",
				"flow.outputWaiting": "Waiting",
				"flow.chars": "{n} chars",
				"flow.dropHere": "Drop a module here",
				"flow.dropActive": "Release to insert",
				"flow.appendHere": "Drop here to append",
				"flow.model": "Model",
				"flow.followDefault": "Follow the default model",
				"flow.prompt": "Prompt",
				"flow.remove": "Remove module",
				"flow.moveUp": "Move up",
				"flow.moveDown": "Move down",
				"flow.elapsed": "{s}s",

				"candidates.title": "Candidate modules",
				"candidates.hint": "Drag below a node, or click to append",
				"candidates.builtin": "Built-in",
				"candidates.edit": "Edit module",
				"candidates.delete": "Delete custom module",
				"candidates.add": "Custom module",
				"candidates.addHint": "Your own name, prompt and model",
				"candidates.customTag": "Custom",

				"viewer.inputTitle": "Input area",
				"viewer.moduleTitle": "{name} · output",
				"viewer.outputTitle": "Output {n}",
				"viewer.tab.output": "Output",
				"viewer.tab.input": "This module's input",
				"viewer.tab.prompt": "Prompt",
				"viewer.tab.info": "Call info",
				"viewer.inputPlaceholder": "Type the source here, then press “Start”.",
				"viewer.outputPlaceholder": "Waiting for output",
				"viewer.moduleInputPlaceholder": "Once it runs, this shows the input the module actually received",
				"viewer.copy": "Copy",
				"viewer.copied": "Copied",
				"viewer.isoTitle": "Exactly what this call sent",
				"viewer.isoMessages": "messages: {n}",
				"viewer.isoHistory": "history: {n}",
				"viewer.isoTools": "tool schemas: {n}",
				"viewer.isoSession": "session: not attached",
				"viewer.isoSystemChars": "{n} prompt chars",
				"viewer.isoInputChars": "{n} input chars",
				"viewer.isoUsage": "tokens {in} / {out}",
				"viewer.inputLocked": "Locked while the flow runs",
				"viewer.isoEmpty": "This module has not run yet; its call summary will appear here.",
				"viewer.noSelection": "Select a node on the left",

				"editor.create": "New custom module",
				"editor.edit": "Edit module",
				"editor.builtinNote": "This is a built-in module: changes are saved as your local default and can be restored at any time.",
				"editor.name": "Module name",
				"editor.namePlaceholder": "for example: legal English polish",
				"editor.model": "Default model",
				"editor.prompt": "Prompt",
				"editor.promptPlaceholder": "The module's whole system prompt; the model sees this plus this module's input, nothing else",
				"editor.resetPrompt": "Restore built-in prompt",
				"editor.save": "Save",
				"editor.cancel": "Cancel",
				"editor.delete": "Delete",
				"editor.missingName": "Give the module a name.",
				"editor.missingPrompt": "Give the module a prompt.",
				"editor.tooMany": "At most {n} custom modules.",

				"config.title": "Translation models",
				"config.subtitle": "The default model, the built-in prompts and your custom modules all live here",
				"config.defaultTitle": "Default model",
				"config.defaultHint": "Modules without their own choice use this one; when unset, the session's agent model is used.",
				"config.current": "Host route: {provider} / {model}",
				"config.agentDefault": "Host route: the session default model",
				"config.test": "Test",
				"config.testing": "Testing…",
				"config.testOk": "Call succeeded: {provider} / {model} in {ms} ms",
				"config.builtinTitle": "Built-in modules",
				"config.builtinHint": "Change the default prompt or model. An empty model follows the default above.",
				"config.customTitle": "Custom modules",
				"config.customHint": "Custom modules are draggable on the flow page too.",
				"config.customEmpty": "No custom modules yet.",
				"config.transferTitle": "Portable configuration",
				"config.transferHint": "Modules, prompts and the default model live in this browser profile. User text is never saved.",
				"config.export": "Export JSON",
				"config.import": "Import JSON",
				"config.importApply": "Apply import",
				"config.importPlaceholder": "Paste an exported document here",
				"config.imported": "Configuration imported.",
				"config.importFailed": "Import failed: not valid JSON.",
				"config.clearCustom": "Clear custom modules",
				"config.cleared": "Custom modules cleared.",
				"config.isolationTitle": "Isolation",
				"config.isolationBody": "Every module is its own model call: it sends this module's prompt and this module's input — never the session history, never tool definitions, never another module's content. The only thing that passes between modules is the previous module's output text.",
				"config.isolationKeys": "The host accepts exactly these fields: {keys}",
				"config.limits": "Limits: input ≤ {input} chars, prompt ≤ {prompt} chars, {timeout}s timeout per call.",

				"route.loading": "Loading models…",
				"route.none": "No models available",
				"route.choose": "Choose a model…",
				"route.noModels": "(no models)",
				"route.unavailable": "Model list unavailable",
				"route.retry": "Retry",
				"route.timeout": "The model list query timed out",
				"route.hostMissing": "The host half exposes no model roster yet; restart DSH to load the newer build",
				"route.manual": "Manual",
				"route.manualProvider": "provider",
				"route.manualModel": "model",
				"route.manualApply": "Apply",
				"route.reload": "Reload models",
				"route.providerTimeout": " (query timed out)",
				"route.providerError": " (unavailable)",

				"action.start": "Start",
				"action.stop": "Stop",
				"action.precision": "Reset precision chain",
				"action.clearFlow": "Clear chain",
				"action.progress": "{done}/{total} done",
				"action.progressDone": "{n} steps done",

				"notice.emptyInput": "Type the source text first.",
				"notice.noModules": "Drag at least one module into the chain first.",
				"notice.done": "Flow finished.",
				"notice.failed": "Module {n} failed and the flow stopped.",
				"notice.cancelled": "Stopped.",
				"notice.copyFailed": "Copy failed; select the text manually.",
				"notice.precision": "Reset to the precision chain.",
				"notice.clearedFlow": "Chain cleared.",
				"notice.added": "Added “{name}”.",
				"notice.removed": "Module removed.",
				"notice.routeSet": "Default model saved.",
				"notice.routeFallback": "Modules without their own model use the default.",
				"notice.notReady": "The host half is not ready yet; wait a moment or press “Reload models”.",
			},
		};

		/** Substitute `{name}` placeholders. */
		function interpolate(template, params) {
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ""));
		}

		/**
		 * Live translator.
		 *
		 * Module-scoped on purpose: the bundle is one plugin instance, and keeping
		 * it here means a component can never be rendered with an undefined `t`.
		 */
		let t = (key, params) => interpolate(MESSAGES.zh[key] ?? key, params);

		/**
		 * Register this plugin's catalogues and point `t` at the shell's locale.
		 * @param ctx - the client plugin context.
		 * @returns a cleanup that withdraws the registrations.
		 */
		function installLocale(ctx) {
			try {
				const locale = ctx.get("locale");
				if (!locale || typeof locale.register !== "function") return () => {};
				const disposeZh = locale.register(LOCALE_NS, "zh", MESSAGES.zh);
				const disposeEn = locale.register(LOCALE_NS, "en", MESSAGES.en);
				const bound = typeof locale.bind === "function" ? locale.bind(LOCALE_NS) : undefined;
				if (typeof bound === "function") {
					t = (key, params) => {
						try {
							const value = bound(key);
							if (typeof value !== "string" || value.length === 0) {
								return interpolate(MESSAGES.zh[key] ?? key, params);
							}
							return interpolate(value, params);
						} catch {
							return interpolate(MESSAGES.zh[key] ?? key, params);
						}
					};
				}
				return () => {
					for (const dispose of [disposeEn, disposeZh]) {
						try {
							if (typeof dispose === "function") dispose();
						} catch {
							/* already released */
						}
					}
				};
			} catch {
				// A locale service that rejects this registration must not cost the
				// panel its text: keep the Chinese fallback and carry on.
				return () => {};
			}
		}

		// ── helpers ──────────────────────────────────────────────────────────

		let idCounter = 0;
		/** A locally unique id for a node or a run. */
		function uid(prefix) {
			idCounter += 1;
			return `${prefix ?? "n"}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		}

		/**
		 * Resolve the host Remote namespace, failing with an actionable message.
		 *
		 * `ctx.get("remote.translateFlow")` rather than `ctx.remote.translateFlow`,
		 * and the difference is load-bearing. A Remote namespace is a Cordis service
		 * whose key literally contains a dot, and Cordis's context proxy resolves
		 * `ctx.remote.translateFlow` by forwarding to `Reflect.get(ctx,
		 * "remote.translateFlow")`, which throws `cannot get property ... without
		 * inject` unless that exact key is in the fiber's `inject`.
		 *
		 * Declaring it is impossible here: this plugin mounts the namespace itself
		 * inside `apply`, while `inject` must already be satisfied before `apply`
		 * runs — the fiber would wait forever on a service only it can create.
		 * `ctx.get()` reads the service table directly, so it is the only route
		 * that works for a self-mounted namespace.
		 */
		function flowApi(ctx) {
			const api = ctx.get("remote.translateFlow");
			if (!api || typeof api.runModule !== "function") {
				throw new Error(t("notice.notReady"));
			}
			return api;
		}

		/** Unwrap the gateway's `{ ok, value } | { ok, error }` envelope. */
		function unwrap(result, what) {
			if (result && result.ok === true) return result.value;
			const message = (result && result.error && result.error.message) || `${what} failed`;
			throw new Error(message);
		}

		/** @returns true for a non-empty string. */
		function isText(value) {
			return typeof value === "string" && value.trim().length > 0;
		}

		/** Marshal a `{ provider, model }` pair into one `<option>` value. */
		function routeKey(route) {
			return route ? `${route.provider}${ROUTE_SEP}${route.model}` : "";
		}

		/** Parse a `{ provider, model }` pair out of one `<option>` value. */
		function parseRouteKey(value) {
			if (typeof value !== "string" || value.length === 0) return null;
			const at = value.indexOf(ROUTE_SEP);
			if (at < 0) return null;
			const provider = value.slice(0, at);
			const model = value.slice(at + ROUTE_SEP.length);
			return isText(provider) && isText(model) ? { provider, model } : null;
		}

		/** Normalise a stored/imported route, or `null` when it is unusable. */
		function cleanRoute(value) {
			if (!value || typeof value !== "object") return null;
			if (!isText(value.provider) || !isText(value.model)) return null;
			return { provider: String(value.provider), model: String(value.model) };
		}

		// ── saved document ───────────────────────────────────────────────────

		/** The document with nothing customised. */
		function emptyDoc() {
			return { version: DOC_VERSION, defaultRoute: null, customModules: [], moduleOverrides: {}, graph: null };
		}

		/**
		 * Coerce anything read from storage into a document this panel can render.
		 *
		 * Storage is user-writable and may hold a document from an older build, so
		 * every field is validated rather than trusted. A document that cannot be
		 * understood degrades to the empty one instead of throwing during mount.
		 */
		function normalizeDoc(raw) {
			const doc = emptyDoc();
			if (!raw || typeof raw !== "object") return doc;
			if (raw.version !== DOC_VERSION) return doc;
			doc.defaultRoute = cleanRoute(raw.defaultRoute);
			if (Array.isArray(raw.customModules)) {
				doc.customModules = raw.customModules
					.filter((entry) => entry && typeof entry === "object" && isText(entry.prompt))
					.slice(0, MAX_CUSTOM_MODULES)
					.map((entry) => ({
						id: isText(entry.id) ? String(entry.id) : uid("custom"),
						name: isText(entry.name) ? String(entry.name) : t("candidates.add"),
						prompt: String(entry.prompt),
						route: cleanRoute(entry.route),
					}));
			}
			if (raw.moduleOverrides && typeof raw.moduleOverrides === "object") {
				for (const [id, value] of Object.entries(raw.moduleOverrides)) {
					if (!value || typeof value !== "object") continue;
					const override = {};
					if (typeof value.prompt === "string" && value.prompt.trim().length > 0) override.prompt = value.prompt;
					const route = cleanRoute(value.route);
					if (route) override.route = route;
					if (Object.keys(override).length > 0) doc.moduleOverrides[id] = override;
				}
			}
			if (Array.isArray(raw.graph)) {
				const nodes = [];
				for (const node of raw.graph) {
					if (!node || typeof node !== "object") continue;
					if (node.kind === "input" && nodes.length === 0) {
						nodes.push({ id: isText(node.id) ? String(node.id) : uid("input"), kind: "input", text: "" });
					} else if (node.kind === "module" && isText(node.prompt)) {
						nodes.push({
							id: isText(node.id) ? String(node.id) : uid("mod"),
							kind: "module",
							defId: isText(node.defId) ? String(node.defId) : "custom",
							name: isText(node.name) ? String(node.name) : t("candidates.add"),
							prompt: String(node.prompt),
							route: cleanRoute(node.route),
							input: "",
							output: "",
							status: "idle",
							error: null,
							elapsedMs: null,
							isolation: null,
							usage: null,
						});
					} else if (node.kind === "output" && isText(node.sourceModuleId)) {
						nodes.push({
							id: isText(node.id) ? String(node.id) : uid("out"),
							kind: "output",
							sourceModuleId: String(node.sourceModuleId),
							text: "",
						});
					}
				}
				// The chain's editing operations splice a module and its output as one
				// two-node block, so the stored shape is repaired into that form here.
				// A document that only *nearly* matches stays usable: rejecting it
				// would throw the user's chain away over one stray node.
				const repaired = repairGraph(nodes);
				if (repaired.length > 0) doc.graph = repaired;
			}
			return doc;
		}

		/** Strip every trace of user text before the graph is written to storage. */
		function serializableGraph(nodes) {
			return nodes.map((node) => {
				if (node.kind === "input") return { kind: "input", id: node.id };
				if (node.kind === "output") return { kind: "output", id: node.id, sourceModuleId: node.sourceModuleId };
				return {
					kind: "module",
					id: node.id,
					defId: node.defId,
					name: node.name,
					prompt: node.prompt,
					route: cleanRoute(node.route),
				};
			});
		}

		/**
		 * Rebuild a node list as the chain the flow edits.
		 *
		 * Every editing operation treats a module and its output as one two-node
		 * block, so a graph that is not shaped that way — an output that drifted away
		 * from its module, a duplicate, an orphan with no module — would make a
		 * splice delete or reorder the wrong node. Repairing on read keeps a
		 * hand-edited or imported document usable.
		 * @param nodes - the nodes parsed from storage.
		 * @returns one input node followed by each module and its output, or `[]`
		 *   when the document holds no module at all.
		 */
		function repairGraph(nodes) {
			// The input node stores no user text, so a document that lost it can be
			// repaired by synthesizing one. Refusing instead would leave `doc.graph`
			// null and let `bootstrap` replace the user's whole chain with the preset.
			const input = nodes.find((node) => node.kind === "input")
				?? (nodes.some((node) => node.kind === "module")
					? { id: uid("input"), kind: "input", text: "" }
					: undefined);
			if (input === undefined) return [];
			const outputsByModule = new Map();
			for (const node of nodes) {
				if (node.kind !== "output") continue;
				const list = outputsByModule.get(node.sourceModuleId);
				if (list === undefined) outputsByModule.set(node.sourceModuleId, [node]);
				else list.push(node);
			}
			const chain = [input];
			for (const node of nodes) {
				if (node.kind !== "module") continue;
				chain.push(node);
				const outputs = outputsByModule.get(node.id);
				// Exactly one output per module: reuse the first and drop the strays.
				chain.push(outputs !== undefined && outputs.length > 0
					? outputs[0]
					: { id: uid("out"), kind: "output", sourceModuleId: node.id, text: "" });
			}
			return chain;
		}

		/**
		 * Read a node list as blocks: the leading input, then one per module.
		 * @param nodes - the current nodes.
		 * @returns `{ input, blocks }`, where each block is `{ module, output }`.
		 */
		function splitBlocks(nodes) {
			const input = nodes.find((node) => node.kind === "input");
			const claimed = new Set();
			const blocks = [];
			for (const node of nodes) {
				if (node.kind !== "module") continue;
				const output = nodes.find((other) => other.kind === "output"
					&& other.sourceModuleId === node.id
					&& !claimed.has(other.id));
				if (output !== undefined) claimed.add(output.id);
				blocks.push({ module: node, output: output ?? null });
			}
			return { input: input ?? null, blocks };
		}

		/**
		 * Flatten blocks back into a node list.
		 * @param input - the leading input node, or `null`.
		 * @param blocks - the module blocks, in chain order.
		 * @returns the node list.
		 */
		function flattenBlocks(input, blocks) {
			const nodes = input !== null ? [input] : [];
			for (const block of blocks) {
				nodes.push(block.module);
				nodes.push(block.output !== null
					? block.output
					: { id: uid("out"), kind: "output", sourceModuleId: block.module.id, text: "" });
			}
			return nodes;
		}

		/** Read the saved document, or the empty one when storage is unusable. */
		function loadDoc() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY);
				if (!raw) return emptyDoc();
				return normalizeDoc(JSON.parse(raw));
			} catch {
				return emptyDoc();
			}
		}

		/** Write the saved document, tolerating a full or unavailable store. */
		function storeDoc(doc) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
			} catch {
				/* storage is a convenience here, never a precondition */
			}
		}

		// ── the store ────────────────────────────────────────────────────────

		/**
		 * The panel's single source of truth.
		 *
		 * Both pages read this, and the flow's run loop writes only to it. That is
		 * what lets a run survive the user switching pages: the loop is not tied to
		 * a mounted component, so unmounting the flow page cannot interrupt or
		 * corrupt a chain in flight.
		 * @param ctx - the client plugin context.
		 * @returns the store.
		 */
		function createStore(ctx) {
			const state = {
				/** `loading` | `ready` | `partial` — partial means the roster is missing. */
				status: "loading",
				rosterError: null,
				serverModules: [],
				precisionFlow: FALLBACK_PRECISION_FLOW.slice(),
				limits: null,
				allowedRunKeys: [],
				routes: null,
				doc: loadDoc(),
				nodes: [],
				selectedId: null,
				running: false,
				progress: { done: 0, total: 0 },
				notice: null,
				activeRunId: null,
				testResult: null,
				testing: false,
			};

			const listeners = new Set();
			/** Pending route-response timer, so disposal can release it. */
			let routesTimer = 0;
			/** Set by `dispose()`: a released store must neither mutate nor notify. */
			let disposed = false;
			/** Bumped on every mutation so components can re-render cheaply. */
			let revision = 0;
			const emit = () => {
				if (disposed) return;
				revision += 1;
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch {
						/* a broken listener must not stop the others */
					}
				}
			};
			const set = (patch) => {
				if (disposed) return;
				Object.assign(state, patch);
				emit();
			};

			/**
			 * The candidate modules: the host's built-ins with the user's overrides
			 * applied, then the user's own modules.
			 */
			const defs = () => {
				const source = state.serverModules.length > 0 ? state.serverModules : FALLBACK_MODULES;
				const overrides = state.doc.moduleOverrides;
				const builtins = source.map((entry) => {
					const override = overrides[entry.id] ?? {};
					return {
						id: entry.id,
						name: entry.name,
						nameEn: entry.nameEn,
						from: entry.from,
						to: entry.to,
						prompt: override.prompt ?? entry.prompt,
						builtinPrompt: entry.prompt,
						route: override.route ?? null,
						builtin: true,
					};
				});
				const customs = state.doc.customModules.map((entry) => ({
					id: entry.id,
					name: entry.name,
					nameEn: null,
					from: null,
					to: null,
					prompt: entry.prompt,
					builtinPrompt: null,
					route: entry.route ?? null,
					builtin: false,
				}));
				return builtins.concat(customs);
			};

			/** @returns the candidate definition with this id, or `undefined`. */
			const findDef = (defId) => defs().find((entry) => entry.id === defId);

			/** Build a fresh module node from a candidate definition. */
			const makeModuleNode = (def) => ({
				id: uid("mod"),
				kind: "module",
				defId: def.id,
				name: def.name,
				prompt: def.prompt,
				route: def.route ?? state.doc.defaultRoute ?? null,
				input: "",
				output: "",
				status: "idle",
				error: null,
				elapsedMs: null,
				isolation: null,
				usage: null,
			});

			/** Build the 精译 chain from the current definitions. */
			const buildPrecisionNodes = () => {
				const nodes = [{ id: uid("input"), kind: "input", text: "" }];
				for (const defId of state.precisionFlow) {
					const def = findDef(defId);
					if (!def) continue;
					const moduleNode = makeModuleNode(def);
					nodes.push(moduleNode);
					nodes.push({ id: uid("out"), kind: "output", sourceModuleId: moduleNode.id, text: "" });
				}
				return nodes;
			};

			/** Persist the configuration and the (text-free) graph shape. */
			const persist = () => {
				state.doc.graph = serializableGraph(state.nodes);
				storeDoc(state.doc);
			};

			/** Replace the graph and keep the persisted shape in step. */
			const setNodes = (nodes) => {
				state.nodes = nodes;
				persist();
				emit();
			};

			/** Mutate one module node through a patch function. */
			const patchModule = (nodeId, patch) => {
				state.nodes = state.nodes.map((node) => (node.id === nodeId && node.kind === "module"
					? { ...node, ...patch }
					: node));
				emit();
			};

			/** Mutate the output node paired with a module. */
			const patchOutputOf = (moduleId, text) => {
				state.nodes = state.nodes.map((node) => (node.kind === "output" && node.sourceModuleId === moduleId
					? { ...node, text }
					: node));
			};

			/** The route one module should call, or `undefined` to use the host default. */
			const routeFor = (node) => cleanRoute(node.route) ?? state.doc.defaultRoute ?? undefined;

			// ── host I/O ──────────────────────────────────────────────────────

			const loadRoster = () => {
				let api;
				try {
					api = flowApi(ctx);
				} catch (error) {
					set({ status: "partial", rosterError: error.message });
					bootstrap();
					return;
				}
				set({ status: state.nodes.length > 0 ? "ready" : "loading" });
				if (typeof api.describe === "function") {
					Promise.resolve()
						.then(() => api.describe())
						.then((result) => {
							const value = unwrap(result, "describe");
							set({
								serverModules: Array.isArray(value.modules) ? value.modules : [],
								precisionFlow: Array.isArray(value.precisionFlow) && value.precisionFlow.length > 0
									? value.precisionFlow
									: FALLBACK_PRECISION_FLOW.slice(),
								limits: value.limits ?? null,
								allowedRunKeys: Array.isArray(value.allowedRunKeys) ? value.allowedRunKeys : [],
								status: "ready",
								rosterError: null,
							});
						})
						.then(bootstrap)
						.catch((error) => {
							set({ status: "partial", rosterError: error && error.message ? error.message : String(error) });
							bootstrap();
						});
				} else {
					// An older host half without `describe`: fall back to the local copy
					// of the modules and seed the chain now rather than waiting forever.
					set({ status: "ready", rosterError: null });
					bootstrap();
				}
				loadRoutes(api);
			};

			const ROUTES_TIMEOUT_MS = 10000;
			const loadRoutes = (apiArg) => {
				let api = apiArg;
				if (!api) {
					try {
						api = flowApi(ctx);
					} catch (error) {
						set({ routes: { providers: [], current: null, unavailable: error.message } });
						return;
					}
				}
				if (typeof api.listRoutes !== "function") {
					set({ routes: { providers: [], current: null, unavailable: t("route.hostMissing") } });
					return;
				}
				set({ routes: null });
				let settled = false;
				// Held on the store, not in this closure: a disposal must be able to
				// release the timer, and `set` is a no-op once the store is released.
				routesTimer = window.setTimeout(() => {
					if (settled) return;
					settled = true;
					set({ routes: { providers: [], current: null, unavailable: t("route.timeout") } });
				}, ROUTES_TIMEOUT_MS);
				Promise.resolve()
					.then(() => api.listRoutes())
					.then((result) => {
						if (settled) return;
						settled = true;
						window.clearTimeout(routesTimer);
						set({ routes: unwrap(result, "listRoutes") });
					})
					.catch((error) => {
						if (settled) return;
						settled = true;
						window.clearTimeout(routesTimer);
						set({ routes: { providers: [], current: null, unavailable: error && error.message ? error.message : String(error) } });
					});
			};

			// ── graph editing ─────────────────────────────────────────────────

			/**
			 * Insert a module and its output node.
			 *
			 * A chain always begins with an input node. If the graph is still empty
			 * (the host roster has not settled yet) one is prepended, so a drop can
			 * never produce a chain with nothing to read from.
			 * @param defId - the candidate definition to instantiate.
			 * @param afterId - the node to insert after, or `null` to append.
			 */
			const insertModule = (defId, afterId) => {
				if (state.running) return;
				const def = findDef(defId);
				if (!def) return;
				const moduleNode = makeModuleNode(def);
				const outputNode = { id: uid("out"), kind: "output", sourceModuleId: moduleNode.id, text: "" };
				let base = state.nodes;
				if (!base.some((node) => node.kind === "input")) {
					base = [{ id: uid("input"), kind: "input", text: "" }].concat(base);
				}
				let anchorId = afterId;
				if (anchorId !== null) {
					const anchorNode = base.find((node) => node.id === anchorId);
					// A module and its output are one unit: dropping onto a module targets
					// the slot *after* that module's output, so a new module can never be
					// inserted between a module and the output that displays it.
					if (anchorNode && anchorNode.kind === "module") {
						const ownOutput = base.find((node) => node.kind === "output" && node.sourceModuleId === anchorNode.id);
						if (ownOutput) anchorId = ownOutput.id;
					}
				}
				const anchor = anchorId === null ? null : base.findIndex((node) => node.id === anchorId);
				const index = anchor === null ? base.length : anchor + 1;
				if (index <= 0) return;
				const next = base.slice();
				next.splice(index, 0, moduleNode, outputNode);
				state.selectedId = moduleNode.id;
				state.notice = { kind: "ok", text: t("notice.added", { name: def.name }) };
				setNodes(next);
			};

			/**
			 * Remove a module together with the output node that displays it.
			 *
			 * Both are located by identity rather than by assuming the output sits at
			 * `index + 1`: the reader repairs the shape, but a splice that trusted
			 * adjacency would still delete a neighbour if that ever stopped holding.
			 */
			const removeModule = (nodeId) => {
				if (state.running) return;
				const module = state.nodes.find((node) => node.id === nodeId && node.kind === "module");
				if (module === undefined) return;
				const next = state.nodes.filter((node) => node.id !== module.id
					&& !(node.kind === "output" && node.sourceModuleId === module.id));
				if (state.selectedId === nodeId) state.selectedId = next.length > 0 ? next[0].id : null;
				state.notice = { kind: "ok", text: t("notice.removed") };
				setNodes(next);
			};

			/**
			 * Move a module and its output node one position up or down.
			 *
			 * The move is a swap of two blocks rather than a splice at an offset, so
			 * the input node can never be pushed out of the lead and a block can never
			 * land between another module and its output.
			 */
			const moveModule = (nodeId, delta) => {
				if (state.running) return;
				const { input, blocks } = splitBlocks(state.nodes);
				const at = blocks.findIndex((block) => block.module.id === nodeId);
				if (at < 0) return;
				const target = at + delta;
				if (target < 0 || target >= blocks.length) return;
				const next = blocks.slice();
				const moved = next.splice(at, 1)[0];
				next.splice(target, 0, moved);
				setNodes(flattenBlocks(input, next));
			};

			/** Append or replace the module at the end of the chain from a definition. */
			const updateModule = (nodeId, patch) => {
				if (state.running) return;
				patchModule(nodeId, patch);
				persist();
			};

			/** Replace the chain's source text. Refused while a run is in flight. */
			const setInput = (text) => {
				// The run loop reads the source once, at the start. Letting it change
				// mid-chain would leave the box showing text no module ever received.
				if (state.running) return;
				state.nodes = state.nodes.map((node) => (node.kind === "input" ? { ...node, text } : node));
				emit();
			};

			const select = (nodeId) => {
				state.selectedId = nodeId;
				emit();
			};

			const resetToPrecision = () => {
				if (state.running) return;
				const nodes = buildPrecisionNodes();
				state.selectedId = nodes.length > 0 ? nodes[0].id : null;
				state.notice = { kind: "ok", text: t("notice.precision") };
				setNodes(nodes);
			};

			const clearFlow = () => {
				if (state.running) return;
				const nodes = [{ id: uid("input"), kind: "input", text: "" }];
				state.selectedId = nodes[0].id;
				state.notice = { kind: "ok", text: t("notice.clearedFlow") };
				setNodes(nodes);
			};

			// ── running ───────────────────────────────────────────────────────

			/**
			 * Run every module in the chain, top to bottom.
			 *
			 * The chain is sequential by construction: module N's input is module
			 * N-1's output, carried in a local variable rather than read back out of
			 * the store, so no re-render can affect what a module receives.
			 */
			const run = async () => {
				if (state.running) return;
				const inputNode = state.nodes.find((node) => node.kind === "input");
				const source = inputNode && typeof inputNode.text === "string" ? inputNode.text : "";
				if (!isText(source)) {
					set({ notice: { kind: "error", text: t("notice.emptyInput") } });
					return;
				}
				const modules = state.nodes.filter((node) => node.kind === "module");
				if (modules.length === 0) {
					set({ notice: { kind: "error", text: t("notice.noModules") } });
					return;
				}
				let api;
				try {
					api = flowApi(ctx);
				} catch (error) {
					set({ notice: { kind: "error", text: error.message } });
					return;
				}

				// Reset every module and output before the chain starts, so a rerun
				// never mixes this run's results with the previous one's.
				state.nodes = state.nodes.map((node) => {
					if (node.kind === "module") {
						return { ...node, input: "", output: "", status: "idle", error: null, elapsedMs: null, isolation: null, usage: null };
					}
					if (node.kind === "output") return { ...node, text: "" };
					return node;
				});
				set({ running: true, notice: null, progress: { done: 0, total: modules.length } });

				let carry = source;
				for (let index = 0; index < modules.length; index += 1) {
					const moduleNode = modules[index];
					// `stop()` clears the flag, so a stop between modules ends the chain
					// here without starting one more call.
					if (state.running === false) break;
					patchModule(moduleNode.id, { status: "running", input: carry, error: null });
					const runId = uid("run");
					const route = routeFor(moduleNode);
					state.activeRunId = runId;
					emit();
					const startedAt = Date.now();
					try {
						// Exactly one prompt and one input cross this boundary — the
						// module's own. Nothing else, for any module.
						const request = {
							runId,
							moduleId: moduleNode.defId,
							prompt: moduleNode.prompt,
							input: carry,
						};
						if (route) {
							request.provider = route.provider;
							request.model = route.model;
						}
						const value = unwrap(await api.runModule(request), moduleNode.name);
						if (value.cancelled) {
							patchModule(moduleNode.id, { status: "idle", error: null, elapsedMs: null });
							patchOutputOf(moduleNode.id, "");
							set({ running: false, activeRunId: null, notice: { kind: "info", text: t("notice.cancelled") } });
							return;
						}
						carry = value.output;
						patchModule(moduleNode.id, {
							status: "done",
							output: value.output,
							isolation: value.isolation ?? null,
							// Carried onto the node, which is what the viewer's info tab reads.
							usage: value.usage ?? null,
							elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : Date.now() - startedAt,
							error: null,
						});
						patchOutputOf(moduleNode.id, value.output);
						state.progress = { done: index + 1, total: modules.length };
						emit();
					} catch (error) {
						// A stop that surfaces as a provider-level abort is a cancellation,
						// not a failure, and must not be reported as one.
						if (state.running === false) {
							patchModule(moduleNode.id, { status: "idle", error: null, elapsedMs: null });
							set({ activeRunId: null, notice: { kind: "info", text: t("notice.cancelled") } });
							return;
						}
						patchModule(moduleNode.id, {
							status: "error",
							error: error && error.message ? error.message : String(error),
							elapsedMs: Date.now() - startedAt,
						});
						set({
							running: false,
							activeRunId: null,
							notice: { kind: "error", text: t("notice.failed", { n: index + 1 }) },
						});
						return;
					}
				}

				set({ running: false, activeRunId: null, notice: { kind: "ok", text: t("notice.done") } });
			};

			/** Ask the host to abort the module that is in flight. */
			const stop = () => {
				const runId = state.activeRunId;
				state.running = false;
				emit();
				if (!runId) return;
				try {
					const api = flowApi(ctx);
					if (typeof api.cancelRun === "function") {
						Promise.resolve()
							.then(() => api.cancelRun({ runId }))
							.catch(() => {});
					}
				} catch {
					/* the run will finish on its own timeout */
				}
			};

			// ── configuration ─────────────────────────────────────────────────

			const setDefaultRoute = (route) => {
				state.doc.defaultRoute = cleanRoute(route);
				storeDoc(state.doc);
				set({ notice: { kind: "ok", text: t("notice.routeSet") } });
			};

			/** Set the transient banner shown in the header. */
			const setNotice = (kind, text) => set({ notice: { kind, text } });

			/** Save a candidate module: an override for a built-in, or a new custom module. */
			const saveModule = ({ id, name, prompt, route }) => {
				const clean = {
					name: isText(name) ? name.trim() : t("candidates.add"),
					prompt: String(prompt),
					route: cleanRoute(route),
				};
				const builtin = defs().find((entry) => entry.id === id && entry.builtin);
				if (builtin) {
					const previousPrompt = builtin.prompt;
					const override = {};
					// Only record what actually differs from the host's own default, so a
					// later host-side prompt improvement still reaches the user.
					if (clean.prompt !== builtin.builtinPrompt) override.prompt = clean.prompt;
					if (clean.route) override.route = clean.route;
					if (Object.keys(override).length === 0) delete state.doc.moduleOverrides[id];
					else state.doc.moduleOverrides[id] = override;
					// Already-placed nodes that still carry the old resolved prompt are
					// refreshed in place; a node the user has hand-edited inside the chain
					// keeps its own prompt, since it no longer equals the definition's.
					state.nodes = state.nodes.map((node) => (node.kind === "module" && node.defId === id && node.prompt === previousPrompt
						? { ...node, prompt: clean.prompt }
						: node));
				} else {
					const existing = state.doc.customModules.find((entry) => entry.id === id);
					if (existing) {
						state.doc.customModules = state.doc.customModules.map((entry) => (entry.id === id
							? { ...entry, name: clean.name, prompt: clean.prompt, route: clean.route }
							: entry));
						// Keep placed nodes of this custom module in step with the edit.
						state.nodes = state.nodes.map((node) => (node.kind === "module" && node.defId === id
							? { ...node, name: clean.name, prompt: clean.prompt, route: clean.route }
							: node));
					} else {
						// The reader caps the list at MAX_CUSTOM_MODULES. Refusing the write
						// at the same number is what stops a reload from silently discarding
						// the modules the user just added.
						if (state.doc.customModules.length >= MAX_CUSTOM_MODULES) {
							set({ notice: { kind: "error", text: t("editor.tooMany", { n: MAX_CUSTOM_MODULES }) } });
							return;
						}
						state.doc.customModules = state.doc.customModules.concat({
							id: `custom-${uid("c")}`,
							name: clean.name,
							prompt: clean.prompt,
							route: clean.route,
						});
					}
				}
				storeDoc(state.doc);
				emit();
			};

			const deleteModule = (id) => {
				state.doc.customModules = state.doc.customModules.filter((entry) => entry.id !== id);
				storeDoc(state.doc);
				emit();
			};

			const resetModulePrompt = (id) => {
				if (state.doc.moduleOverrides[id]) {
					const override = { ...state.doc.moduleOverrides[id] };
					delete override.prompt;
					if (Object.keys(override).length === 0) delete state.doc.moduleOverrides[id];
					else state.doc.moduleOverrides[id] = override;
					storeDoc(state.doc);
					emit();
				}
			};

			/** Run a one-word probe through a route, so the user can check it works. */
			const testRoute = async (route) => {
				const chosen = cleanRoute(route) ?? state.doc.defaultRoute;
				let api;
				try {
					api = flowApi(ctx);
				} catch (error) {
					set({ testResult: { ok: false, text: error.message }, testing: false });
					return;
				}
				set({ testing: true, testResult: null });
				const request = {
					runId: uid("probe"),
					moduleId: "__probe__",
					prompt: "Reply with exactly one word: pong",
					input: "ping",
				};
				if (chosen) {
					request.provider = chosen.provider;
					request.model = chosen.model;
				}
				try {
					const value = unwrap(await api.runModule(request), "probe");
					if (value.cancelled) {
						set({ testing: false, testResult: { ok: false, text: t("notice.cancelled") } });
						return;
					}
					set({
						testing: false,
						testResult: {
							ok: true,
							text: t("config.testOk", { provider: value.provider, model: value.model, ms: value.elapsedMs }),
							output: value.output,
						},
					});
				} catch (error) {
					set({
						testing: false,
						testResult: { ok: false, text: error && error.message ? error.message : String(error) },
					});
				}
			};

			const importDoc = (json) => {
				try {
					const parsed = JSON.parse(json);
					const doc = normalizeDoc({ ...parsed, version: DOC_VERSION });
					state.doc = doc;
					state.nodes = doc.graph ? doc.graph : buildPrecisionNodes();
					state.selectedId = state.nodes.length > 0 ? state.nodes[0].id : null;
					state.notice = { kind: "ok", text: t("config.imported") };
					persist();
					emit();
				} catch {
					set({ notice: { kind: "error", text: t("config.importFailed") } });
				}
			};

			const clearCustomModules = () => {
				state.doc.customModules = [];
				storeDoc(state.doc);
				set({ notice: { kind: "ok", text: t("config.cleared") } });
			};

			// ── first load ────────────────────────────────────────────────────

			/** Populate the graph once the host roster is known. Runs at most once. */
			let bootstrapped = false;
			const bootstrap = () => {
				if (bootstrapped) return;
				bootstrapped = true;
				if (state.doc.graph && state.doc.graph.length > 0) {
					state.nodes = state.doc.graph;
				} else {
					state.nodes = buildPrecisionNodes();
				}
				state.selectedId = state.nodes.length > 0 ? state.nodes[0].id : null;
				persist();
				emit();
			};

			return {
				state,
				get revision() {
					return revision;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** Release the store: stop notifying, and drop any pending route timer. */
				dispose() {
					disposed = true;
					window.clearTimeout(routesTimer);
					listeners.clear();
				},
				defs,
				findDef,
				bootstrap,
				loadRoster,
				loadRoutes: () => loadRoutes(undefined),
				insertModule,
				removeModule,
				moveModule,
				updateModule,
				setInput,
				select,
				resetToPrecision,
				clearFlow,
				run,
				stop,
				setDefaultRoute,
				setNotice,
				saveModule,
				deleteModule,
				resetModulePrompt,
				testRoute,
				importDoc,
				clearCustomModules,
				exportDoc: () => JSON.stringify(state.doc, null, 2),
				routeFor,
			};
		}

		/**
		 * Subscribe a component to the store.
		 *
		 * Deliberately not `useSyncExternalStore`: this bundle must run on whatever
		 * React the shell provides, and a plain subscription works on every version
		 * the panel could meet.
		 */
		function useStore(store) {
			const [, bump] = useState(0);
			useEffect(() => store.subscribe(() => bump((value) => value + 1)), [store]);
			return store.state;
		}

		// ── small view pieces ────────────────────────────────────────────────

		/** A coloured status chip for one module node. */
		function StatusChip({ status }) {
			const table = {
				running: [C.warn, t("panel.status.running")],
				error: [C.error, t("panel.status.error")],
				done: [C.success, t("panel.status.done")],
				idle: [C.idle, t("panel.status.idle")],
			};
			const [color, label] = table[status] ?? table.idle;
			return h("span", { style: chipStyle(color) }, label);
		}

		/** A small round status dot. */
		function StatusDot({ status }) {
			const color = status === "done"
				? C.success
				: status === "running"
					? C.warn
					: status === "error"
						? C.error
						: C.idle;
			return h("span", {
				style: {
					width: 7,
					height: 7,
					borderRadius: 999,
					background: color,
					flex: "0 0 auto",
					display: "inline-block",
				},
			});
		}

		/**
		 * A drop target between two chain nodes.
		 *
		 * `onDragOver` must call `preventDefault` or the browser refuses the drop,
		 * which is the single most common reason a hand-rolled HTML5 drag target
		 * silently does nothing.
		 */
		function DropSlot({ active, isLast, onHover, onLeave, onDrop }) {
			return h("div", {
				onDragOver: (event) => {
					event.preventDefault();
					if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
					onHover();
				},
				onDragEnter: (event) => {
					event.preventDefault();
					onHover();
				},
				onDragLeave: () => onLeave(),
				onDrop: (event) => {
					event.preventDefault();
					onDrop(event);
				},
				style: {
					margin: "2px 0 2px 14px",
					height: 22,
					borderRadius: 6,
					border: `1px dashed ${active ? C.brand : C.border2}`,
					background: active ? C.layer2 : "transparent",
					color: active ? C.brand : C.textFaint,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: 10.5,
					transition: "border-color .12s ease, color .12s ease",
					flex: "0 0 auto",
				},
			}, active ? t("flow.dropActive") : isLast ? t("flow.appendHere") : t("flow.dropHere"));
		}

		/**
		 * One candidate module card.
		 *
		 * Draggable while idle and clickable at all times: the click path exists
		 * because a drag gesture is not available to every user, and refusing to
		 * work without one would make the panel unusable for them.
		 */
		function CandidateCard({ def, disabled, onEdit, onDelete, onDragStart, onAppend }) {
			const [hover, setHover] = useState(false);
			return h("div", {
				draggable: !disabled,
				onDragStart: (event) => {
					if (disabled) {
						event.preventDefault();
						return;
					}
					onDragStart(event);
				},
				onClick: () => {
					if (!disabled) onAppend();
				},
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				title: t("candidates.hint"),
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 4,
					padding: "7px 8px",
					border: `1px solid ${hover && !disabled ? C.brand : C.border1}`,
					borderRadius: 8,
					background: C.layer2,
					cursor: disabled ? "not-allowed" : "grab",
					opacity: disabled ? 0.5 : 1,
				},
			},
				h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
					h("span", { style: { fontSize: 12, fontWeight: 600, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, def.name),
					def.builtin
						? h("span", { style: chipStyle(C.idle) }, t("candidates.builtin"))
						: h("span", { style: chipStyle(C.brand) }, t("candidates.customTag")),
					h("button", {
						type: "button",
						title: t("candidates.edit"),
						disabled,
						onClick: (event) => {
							event.stopPropagation();
							onEdit();
						},
						style: buttonStyle("ghost", !disabled),
					}, "✎"),
					def.builtin
						? null
						: h("button", {
							type: "button",
							title: t("candidates.delete"),
							disabled,
							onClick: (event) => {
								event.stopPropagation();
								onDelete();
							},
							style: buttonStyle("danger", !disabled),
						}, "✕"),
				),
				h("div", {
					style: {
						fontSize: 10.5,
						color: C.textFaint,
						lineHeight: 1.45,
						maxHeight: 30,
						overflow: "hidden",
					},
				}, def.prompt),
			);
		}

		/**
		 * The module editor, shared by the flow page and the configuration page.
		 *
		 * A built-in module can be edited too: the change is stored as a local
		 * override and can be restored, which is what makes "默认模块的模型和提示词
		 * 准备好" a starting point rather than a fixed menu.
		 */
		function ModuleEditor({ store, draft, onClose }) {
			const state = useStore(store);
			const definition = draft.id ? store.findDef(draft.id) : null;
			const builtin = Boolean(definition && definition.builtin);
			const [name, setName] = useState(draft.name ?? "");
			const [prompt, setPrompt] = useState(draft.prompt ?? "");
			const [routeValue, setRouteValue] = useState(routeKey(cleanRoute(draft.route) ?? state.doc.defaultRoute));
			const [error, setError] = useState(null);

			const providers = (state.routes && state.routes.providers) || [];
			const commit = () => {
				if (!builtin && !isText(name)) {
					setError(t("editor.missingName"));
					return;
				}
				if (!isText(prompt)) {
					setError(t("editor.missingPrompt"));
					return;
				}
				store.saveModule({
					id: draft.id ?? null,
					name: builtin ? (definition ? definition.name : name) : name,
					prompt,
					route: parseRouteKey(routeValue),
				});
				onClose();
			};

			return h("div", {
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 60,
					// Theme-aware scrim: a literal colour would be wrong in one of the
					// two themes, and there is no mask token to borrow.
					background: "color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 16,
				},
				onClick: onClose,
			},
				h("div", {
					onClick: (event) => event.stopPropagation(),
					style: {
						width: 560,
						maxWidth: "94vw",
						maxHeight: "88vh",
						overflow: "auto",
						background: C.layer1,
						color: C.text,
						border: `1px solid ${C.border1}`,
						borderRadius: 12,
						padding: 14,
						display: "flex",
						flexDirection: "column",
						gap: 10,
						boxSizing: "border-box",
					},
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						h("span", { style: { fontSize: 13, fontWeight: 600, flex: "1 1 auto" } },
							draft.id ? t("editor.edit") : t("editor.create")),
						h("button", { type: "button", style: buttonStyle("ghost", true), onClick: onClose }, t("editor.cancel")),
					),

					builtin
						? h("div", { style: { ...hintStyle, lineHeight: 1.5 } }, t("editor.builtinNote"))
						: h("div", null,
							h("label", { style: labelStyle }, t("editor.name")),
							h("input", {
								style: fieldStyle,
								value: name,
								placeholder: t("editor.namePlaceholder"),
								spellCheck: false,
								onChange: (event) => setName(event.target.value),
							}),
						),

					h("div", null,
						h("label", { style: labelStyle }, t("editor.model")),
						h(RouteSelect, {
							value: routeValue,
							onChange: setRouteValue,
							providers,
							fallbackLabel: t("flow.followDefault"),
							allowEmpty: true,
						}),
					),

					h("div", { style: { display: "flex", flexDirection: "column", minHeight: 160 } },
						h("label", { style: labelStyle }, t("editor.prompt")),
						h("textarea", {
							style: { ...monoStyle, flex: "1 1 auto", minHeight: 140, resize: "vertical" },
							value: prompt,
							placeholder: t("editor.promptPlaceholder"),
							spellCheck: false,
							onChange: (event) => setPrompt(event.target.value),
						}),
					),

					error ? h("div", { style: { fontSize: 11, color: C.error } }, error) : null,

					h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						builtin
							? h("button", {
								type: "button",
								style: buttonStyle("ghost", true),
								onClick: () => setPrompt(definition ? definition.builtinPrompt : ""),
							}, t("editor.resetPrompt"))
							: null,
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", { type: "button", style: buttonStyle("ghost", true), onClick: onClose }, t("editor.cancel")),
						h("button", { type: "button", style: buttonStyle("primary", true), onClick: commit }, t("editor.save")),
					),
				),
			);
		}

		/**
		 * The provider/model picker.
		 *
		 * One `<optgroup>` per provider, one `<option>` per model, plus an optional
		 * empty choice meaning "no explicit route".
		 */
		function RouteSelect({ value, onChange, providers, fallbackLabel, allowEmpty, disabled, title }) {
			const hasValue = providers.some((provider) => provider.models.some((model) => `${provider.id}${ROUTE_SEP}${model.id}` === value));
			// A provider that timed out and a provider that genuinely has no models
			// both render an empty group. Saying which is which is the difference
			// between "wait" and "pick another provider".
			const providerLabel = (provider) => {
				if (provider.models.length > 0) return provider.name;
				if (provider.status === "timeout") return `${provider.name}${t("route.providerTimeout")}`;
				if (provider.status === "error") return `${provider.name}${t("route.providerError")}`;
				return provider.name;
			};
			return h("select", {
				style: { ...selectStyle, opacity: disabled ? 0.6 : 1 },
				value,
				disabled,
				title,
				// `title` is a tooltip, not an accessible name; the control needs one.
				"aria-label": title ?? fallbackLabel,
				onChange: (event) => onChange(event.target.value),
			},
				allowEmpty || !value ? h("option", { value: "" }, fallbackLabel) : null,
				!hasValue && value ? h("option", { value }, `（${value.split(ROUTE_SEP).join(" / ")}）`) : null,
				providers.map((provider) => h("optgroup", { key: provider.id, label: providerLabel(provider) },
					provider.models.length === 0
						? h("option", { key: `${provider.id}${ROUTE_SEP}`, value: "", disabled: true }, t("route.noModels"))
						: provider.models.map((model) => h("option", {
							key: `${provider.id}${ROUTE_SEP}${model.id}`,
							value: `${provider.id}${ROUTE_SEP}${model.id}`,
						}, model.name)),
				)),
			);
		}

		/** The provider/model picker with a manual fallback for an unusable roster. */
		function RoutePicker({ store, route, onChange, disabled }) {
			const state = useStore(store);
			const [manual, setManual] = useState(false);
			const [manualProvider, setManualProvider] = useState("");
			const [manualModel, setManualModel] = useState("");
			const routes = state.routes;
			const providers = (routes && routes.providers) || [];

			if (routes && routes.unavailable) {
				return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
					h("span", { style: { fontSize: 11, color: C.warn } }, t("route.unavailable")),
					h("button", {
						type: "button",
						style: buttonStyle("ghost", !disabled),
						disabled,
						title: routes.unavailable,
						onClick: () => store.loadRoutes(),
					}, t("route.retry")),
					h("button", {
						type: "button",
						style: buttonStyle("ghost", !disabled),
						disabled,
						onClick: () => {
							const current = cleanRoute(route) ?? state.doc.defaultRoute;
							setManualProvider(current ? current.provider : "");
							setManualModel(current ? current.model : "");
							setManual(true);
						},
					}, t("route.manual")),
					manual
						? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
							h("input", {
								style: { ...fieldStyle, width: 110 },
								value: manualProvider,
								placeholder: t("route.manualProvider"),
								spellCheck: false,
								onChange: (event) => setManualProvider(event.target.value),
							}),
							h("input", {
								style: { ...fieldStyle, width: 130 },
								value: manualModel,
								placeholder: t("route.manualModel"),
								spellCheck: false,
								onChange: (event) => setManualModel(event.target.value),
							}),
							h("button", {
								type: "button",
								style: buttonStyle("primary", true),
								onClick: () => {
									onChange({ provider: manualProvider.trim(), model: manualModel.trim() });
									setManual(false);
								},
							}, t("route.manualApply")),
						)
						: null,
				);
			}

			return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
				h(RouteSelect, {
					value: routeKey(route),
					onChange: (value) => onChange(parseRouteKey(value)),
					providers,
					fallbackLabel: routes ? t("flow.followDefault") : t("route.loading"),
					allowEmpty: true,
					disabled: disabled || providers.length === 0,
					title: t("config.defaultHint"),
				}),
			);
		}

		/**
		 * The right-hand viewer: input area, module output, and the isolation record
		 * the host returned for the selected module.
		 */
		function Viewer({ store, selected, copiedKey, onCopy, running }) {
			const [tab, setTab] = useState("output");
			useEffect(() => {
				setTab("output");
			}, [selected ? selected.id : null]);

			if (!selected) {
				return h("div", { style: { ...cardStyle, flex: "1 1 58%", minHeight: 150 } },
					h("div", { style: cardHeadStyle }, h("span", { style: sectionTitleStyle }, t("viewer.noSelection"))),
				);
			}

			const isInput = selected.kind === "input";
			const title = isInput
				? t("viewer.inputTitle")
				: selected.kind === "module"
					? t("viewer.moduleTitle", { name: selected.name })
					: t("viewer.outputTitle", { n: selected.index });

			const tabs = selected.kind === "module"
				? [
					["output", t("viewer.tab.output")],
					["input", t("viewer.tab.input")],
					["prompt", t("viewer.tab.prompt")],
					["info", t("viewer.tab.info")],
				]
				: [];

			let text;
			if (selected.kind === "input") {
				text = selected.text;
			} else if (selected.kind === "output") {
				text = selected.text;
			} else {
				text = tab === "input" ? selected.input : tab === "prompt" ? selected.prompt : selected.output;
			}
			const chars = typeof text === "string" ? text.length : 0;

			let body;
			if (isInput) {
				body = h("textarea", {
					style: { ...textAreaStyle, minHeight: 120, opacity: running ? 0.75 : 1 },
					value: selected.text,
					placeholder: running ? t("viewer.inputLocked") : t("viewer.inputPlaceholder"),
					spellCheck: false,
					// The run reads the source once, at the start, so editing it mid-chain
					// would desynchronise the text on screen from the text that ran.
					readOnly: running === true,
					onChange: (event) => store.setInput(event.target.value),
				});
			} else if (tab === "info") {
				const iso = selected.kind === "module" ? selected.isolation : null;
				body = iso
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5, color: C.textDim, lineHeight: 1.7 } },
						h("div", { style: { fontWeight: 600, color: C.text } }, t("viewer.isoTitle")),
						h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
							h("span", { style: chipStyle(C.success) }, t("viewer.isoMessages", { n: iso.messagesSent })),
							h("span", { style: chipStyle(C.success) }, t("viewer.isoHistory", { n: iso.historyMessages })),
							h("span", { style: chipStyle(C.success) }, t("viewer.isoTools", { n: iso.toolSchemas })),
							h("span", { style: chipStyle(C.success) }, t("viewer.isoSession")),
							h("span", { style: chipStyle(C.idle) }, t("viewer.isoSystemChars", { n: iso.systemChars })),
							h("span", { style: chipStyle(C.idle) }, t("viewer.isoInputChars", { n: iso.inputChars })),
							// What the call cost, when the provider reported it.
							selected.usage
								? h("span", { style: chipStyle(C.idle) }, t("viewer.isoUsage", {
									in: selected.usage.inputTokens ?? "–",
									out: selected.usage.outputTokens ?? "–",
								}))
								: null,
							typeof selected.elapsedMs === "number"
								? h("span", { style: chipStyle(C.idle) }, t("flow.elapsed", { s: (selected.elapsedMs / 1000).toFixed(1) }))
								: null,
						),
					)
					: h("div", { style: { fontSize: 11.5, color: C.textFaint } }, t("viewer.isoEmpty"));
			} else {
				body = h("textarea", {
					style: textAreaStyle,
					value: typeof text === "string" ? text : "",
					readOnly: true,
					placeholder: selected.kind === "output" || (selected.kind === "module" && tab === "output")
						? t("viewer.outputPlaceholder")
						: t("viewer.moduleInputPlaceholder"),
					spellCheck: false,
				});
			}

			const copyValue = isInput ? selected.text : typeof text === "string" ? text : "";

			return h("div", { style: { ...cardStyle, flex: "1 1 58%", minHeight: 150 } },
				h("div", { style: cardHeadStyle },
					h("span", { style: sectionTitleStyle }, title),
					h("span", { style: hintStyle }, t("flow.chars", { n: chars })),
					h("span", { style: { flex: "1 1 auto" } }),
					tabs.map(([id, label]) => h("button", {
						key: id,
						type: "button",
						style: tab === id
							? { ...buttonStyle("ghost", true), borderColor: C.brand, color: C.brand }
							: buttonStyle("ghost", true),
						onClick: () => setTab(id),
					}, label)),
					!isInput && copyValue
						? h("button", {
							type: "button",
							style: buttonStyle("ghost", true),
							onClick: () => onCopy(copyValue, selected.id),
						}, copiedKey === selected.id ? t("viewer.copied") : t("viewer.copy"))
						: null,
				),
				h("div", { style: { ...cardBodyStyle, padding: 10 } }, body),
			);
		}

		/**
		 * The flow page.
		 *
		 * Three regions, left to right then top to bottom: the chain, the candidate
		 * modules, and the viewer. Everything the page shows about the run — status
		 * colour, progress count, elapsed time, isolation summary — comes from the
		 * store, which is written by the run loop above rather than by this render.
		 */
		function createFlowPage(ctx, store) {
			return function FlowPage() {
				const state = useStore(store);
				const [dropTarget, setDropTarget] = useState(null);
				const [editor, setEditor] = useState(null);
				const [copiedKey, setCopiedKey] = useState(null);
				const copyTimer = useRef(0);
				useEffect(() => () => window.clearTimeout(copyTimer.current), []);
				const definitions = store.defs();
				const modules = state.nodes.filter((node) => node.kind === "module");
				// While a run is in flight the total is the chain it started with. After
				// it, the chain may have been edited, so the readout follows the modules
				// that are there now instead of a count that is no longer true.
				const progressTotal = state.running ? state.progress.total : modules.length;
				const progressDone = state.running
					? state.progress.done
					: Math.min(state.progress.done, modules.length);

				let outputOrdinal = 0;
				const decorated = state.nodes.map((node) => {
					if (node.kind === "output") outputOrdinal += 1;
					return node.kind === "output" ? { ...node, index: outputOrdinal } : node;
				});
				// Read from `decorated`, not from `state.nodes`: the ordinal the viewer
				// titles an output with is attached by the pass above, so the raw node
				// would render "Output " with no number after it.
				const selected = decorated.find((node) => node.id === state.selectedId) ?? null;

				const copy = async (value, key) => {
					try {
						await navigator.clipboard.writeText(value);
						// One timer at a time: without the clear, a second copy within
						// 1.5s is un-marked by the first timer, and an unmount leaves a
						// setState behind.
						window.clearTimeout(copyTimer.current);
						setCopiedKey(key);
						copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1500);
					} catch {
						store.setNotice("error", t("notice.copyFailed"));
					}
				};

				const readDrop = (event) => {
					try {
						return String(event.dataTransfer.getData("text/plain") || "");
					} catch {
						return "";
					}
				};

				const notice = state.notice;

				return h("div", { style: panelStyle },
					// ── header ──
					h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 14, fontWeight: 600 } }, t("flow.title")),
						h("span", { style: { fontSize: 11, color: C.textDim } }, t("flow.subtitle")),
						h("span", { style: { flex: "1 1 auto" } }),
						state.running
							? h("span", { style: hintStyle }, t("action.progress", { done: progressDone, total: progressTotal }))
							: progressDone > 0 && progressTotal > 0
								? h("span", { style: hintStyle }, t("action.progressDone", { n: progressDone }))
								: null,
						state.running
							? h("button", { type: "button", style: buttonStyle("ghost", true), onClick: () => store.stop() }, t("action.stop"))
							: h("button", {
								type: "button",
								style: buttonStyle("primary", modules.length > 0),
								disabled: modules.length === 0,
								onClick: () => store.run(),
							}, t("action.start")),
						h("button", {
							type: "button",
							style: buttonStyle("ghost", !state.running),
							disabled: state.running,
							onClick: () => store.resetToPrecision(),
						}, t("action.precision")),
						h("button", {
							type: "button",
							style: buttonStyle("ghost", !state.running),
							disabled: state.running,
							onClick: () => store.clearFlow(),
						}, t("action.clearFlow")),
					),

					notice
						? h("div", {
							style: {
								fontSize: 11,
								color: notice.kind === "error" ? C.error : notice.kind === "ok" ? C.success : C.textDim,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							},
							title: notice.text,
							// Announced rather than only painted: the outcome of a run must
							// not depend on the user watching one corner of the panel.
							role: "status",
							"aria-live": "polite",
						}, notice.text)
						: null,

					// ── body ──
					h("div", { style: { flex: "1 1 auto", minHeight: 0, display: "flex", gap: 10 } },
						// left: the chain
						h("div", { style: { ...cardStyle, width: "40%", minWidth: 280, flex: "0 0 auto" } },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("flow.chainTitle")),
								h("span", { style: hintStyle }, t("flow.chainHint")),
								h("span", { style: { flex: "1 1 auto" } }),
								modules.length > 0
									? h("span", { style: hintStyle }, `${progressDone}/${progressTotal}`)
									: null,
							),
							h("div", { style: { ...cardBodyStyle, padding: 8 } },
								modules.length === 0 && state.status !== "loading"
									? h("div", { style: { fontSize: 11, color: C.textFaint, lineHeight: 1.6, padding: "2px 2px 6px" } }, t("flow.chainEmpty"))
									: null,

								decorated.map((node, index) => {
									const next = decorated[index + 1];
									const isLast = index === decorated.length - 1;
									const accent = node.kind === "module"
										? node.status === "running"
											? C.warn
											: node.status === "done"
												? C.success
												: node.status === "error"
													? C.error
													: C.border2
										: node.kind === "output"
											? (decorated.find((entry) => entry.id === node.sourceModuleId) ?? {}).status === "done"
												? C.success
												: C.border2
											: C.brand;

									const selectedNow = state.selectedId === node.id;
									const common = {
										key: node.id,
										onClick: () => store.select(node.id),
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 4,
											padding: "6px 8px",
											border: `1px solid ${selectedNow ? C.brand : C.border1}`,
											borderLeft: `3px solid ${accent}`,
											borderRadius: 8,
											background: selectedNow ? C.layer2 : C.layer1,
											cursor: "pointer",
											flex: "0 0 auto",
										},
									};

									if (node.kind === "input") {
										return h("div", { key: node.id, style: { display: "flex", flexDirection: "column", flex: "0 0 auto" } },
											h("div", common,
												h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
													h("span", { style: { fontSize: 12, fontWeight: 600 } }, t("flow.input")),
													h("span", { style: hintStyle }, t("flow.chars", { n: node.text.length })),
												),
												h("div", {
													style: {
														fontSize: 10.5,
														color: C.textFaint,
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													},
												}, isText(node.text) ? node.text : t("flow.inputEmpty")),
											),
											h(DropSlot, {
												key: `${node.id}-slot`,
												active: dropTarget === node.id,
												isLast,
												onHover: () => setDropTarget(node.id),
												onLeave: () => setDropTarget(null),
												onDrop: (event) => {
													setDropTarget(null);
													const defId = readDrop(event);
													if (defId) store.insertModule(defId, node.id);
												},
											}),
										);
									}

									if (node.kind === "module") {
										const route = state.doc.defaultRoute;
										// Three genuinely different cases: this module's own model,
										// the configured default, and "whatever the session uses".
										const routeLabel = node.route
											? `${node.route.provider} / ${node.route.model}`
											: route
												? `${route.provider} / ${route.model}`
												: t("flow.followDefault");
										return h("div", { key: node.id, style: { display: "flex", flexDirection: "column", flex: "0 0 auto" } },
											h("div", {
												...common,
												className: node.status === "running" ? "dsh-tf-running" : undefined,
											},
												h("div", { style: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" } },
													h(StatusDot, { status: node.status }),
													h("span", { style: { fontSize: 12, fontWeight: 600 } }, node.name),
													h(StatusChip, { status: node.status }),
													node.status === "done" && node.elapsedMs !== null
														? h("span", { style: hintStyle }, t("flow.elapsed", { s: (node.elapsedMs / 1000).toFixed(1) }))
														: null,
													h("span", { style: { flex: "1 1 auto" } }),
													h("button", {
														type: "button",
														title: t("flow.moveUp"),
														style: buttonStyle("ghost", !state.running),
														disabled: state.running,
														onClick: (event) => {
															event.stopPropagation();
															store.moveModule(node.id, -1);
														},
													}, "↑"),
													h("button", {
														type: "button",
														title: t("flow.moveDown"),
														style: buttonStyle("ghost", !state.running),
														disabled: state.running,
														onClick: (event) => {
															event.stopPropagation();
															store.moveModule(node.id, 1);
														},
													}, "↓"),
													h("button", {
														type: "button",
														title: t("flow.remove"),
														style: buttonStyle("danger", !state.running),
														disabled: state.running,
														onClick: (event) => {
															event.stopPropagation();
															store.removeModule(node.id);
														},
													}, "✕"),
												),
												h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
													h("span", { style: hintStyle }, t("flow.model")),
													h(RouteSelect, {
														value: routeKey(node.route),
														onChange: (value) => store.updateModule(node.id, { route: parseRouteKey(value) }),
														providers: (state.routes && state.routes.providers) || [],
														fallbackLabel: t("flow.followDefault"),
														allowEmpty: true,
														disabled: state.running,
														title: routeLabel,
													}),
												),
												h("details", {
													onClick: (event) => event.stopPropagation(),
													style: { fontSize: 10.5, color: C.textFaint },
												},
													h("summary", { style: { cursor: "pointer" } }, t("flow.prompt")),
													h("textarea", {
														style: { ...monoStyle, marginTop: 4, minHeight: 70, resize: "vertical" },
														value: node.prompt,
														disabled: state.running,
														spellCheck: false,
														onChange: (event) => store.updateModule(node.id, { prompt: event.target.value }),
													}),
												),
												node.status === "error" && node.error
													? h("div", { style: { fontSize: 10.5, color: C.error, wordBreak: "break-word" } }, node.error)
													: null,
											),
											// Deliberately no drop slot after a module: a module and the
											// output that follows it are one unit, so nothing may be
											// inserted between them. A new module goes either above this
											// module (the previous node's slot) or below its output (that
											// output's own slot).
										);
									}

									// output node
									const source = decorated.find((entry) => entry.id === node.sourceModuleId);
									return h("div", { key: node.id, style: { display: "flex", flexDirection: "column", flex: "0 0 auto" } },
										h("div", {
											...common,
											style: {
												...common.style,
												borderLeft: `3px solid ${source && source.status === "done" ? C.success : C.border2}`,
											},
										},
											h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
												h("span", { style: { fontSize: 12, fontWeight: 600 } }, t("flow.output", { n: node.index })),
												h("span", { style: hintStyle }, t("flow.chars", { n: node.text.length })),
											),
											h("div", {
												style: {
													fontSize: 10.5,
													color: C.textFaint,
													maxHeight: 30,
													overflow: "hidden",
												},
											}, isText(node.text) ? node.text.slice(0, 120) : t("flow.outputWaiting")),
										),
										h(DropSlot, {
											key: `${node.id}-slot`,
											active: dropTarget === node.id,
											isLast,
											onHover: () => setDropTarget(node.id),
											onLeave: () => setDropTarget(null),
											onDrop: (event) => {
												setDropTarget(null);
												const defId = readDrop(event);
												if (defId) store.insertModule(defId, node.id);
											},
										}),
									);
								}),

								// An empty chain still needs a first target: drop onto nothing.
								state.nodes.length === 0
									? h(DropSlot, {
										active: dropTarget === "empty",
										isLast: true,
										onHover: () => setDropTarget("empty"),
										onLeave: () => setDropTarget(null),
										onDrop: (event) => {
											setDropTarget(null);
											const defId = readDrop(event);
											if (defId) store.insertModule(defId, null);
										},
									})
									: null,
							),
						),

						// right: candidates above, viewer below
						h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 } },
							h("div", { style: { ...cardStyle, flex: "0 0 42%", minHeight: 130 } },
								h("div", { style: cardHeadStyle },
									h("span", { style: sectionTitleStyle }, t("candidates.title")),
									h("span", { style: hintStyle }, t("candidates.hint")),
								),
								h("div", { style: { ...cardBodyStyle, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, alignContent: "start" } },
									definitions.map((def) => h(CandidateCard, {
										key: def.id,
										def,
										disabled: state.running,
										onEdit: () => setEditor({ id: def.id, name: def.name, prompt: def.prompt, route: def.route }),
										onDelete: () => store.deleteModule(def.id),
										onDragStart: (event) => {
											try {
												event.dataTransfer.setData("text/plain", def.id);
												event.dataTransfer.effectAllowed = "copy";
											} catch {
												/* the click path still works */
											}
										},
										onAppend: () => store.insertModule(def.id, null),
									})),
									h("button", {
										type: "button",
										disabled: state.running,
										onClick: () => setEditor({ id: null, name: "", prompt: "", route: null }),
										style: {
											border: `1px dashed ${C.border2}`,
											background: "transparent",
											color: C.brand,
											borderRadius: 8,
											padding: "7px 8px",
											textAlign: "left",
											font: "inherit",
											cursor: state.running ? "not-allowed" : "pointer",
											display: "flex",
											flexDirection: "column",
											gap: 3,
										},
									},
										h("span", { style: { fontSize: 12, fontWeight: 600 } }, `＋ ${t("candidates.add")}`),
										h("span", { style: hintStyle }, t("candidates.addHint")),
									),
								),
							),
							h(Viewer, {
								store,
								selected,
								copiedKey,
								onCopy: copy,
								running: state.running,
							}),
						),
					),

					editor
						? h(ModuleEditor, {
							key: editor.id ?? "new",
							store,
							draft: editor,
							onClose: () => setEditor(null),
						})
						: null,
				);
			};
		}

		/** Sidebar glyph for the configuration page: a gear. */
		function ConfigIcon({ size }) {
			const dimension = typeof size === "number" ? size : 16;
			return h("svg", {
				width: dimension,
				height: dimension,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
				h("circle", { cx: 8, cy: 8, r: 2.3 }),
				h("path", {
					d: "M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1",
				}),
			);
		}

		/**
		 * The configuration page.
		 *
		 * Every control here writes through the same store the flow page reads, so a
		 * change is visible on the flow page immediately. The default model is the
		 * tier the run loop consults between a module's own route and the session
		 * default — the one tier the flow page cannot set for itself, which is why
		 * this page exists at all.
		 * @param ctx - the client plugin context.
		 * @param store - the shared store.
		 * @returns the page component.
		 */
		function createConfigPage(ctx, store) {
			const sectionStyle = { ...cardStyle, flex: "0 0 auto" };
			const sectionBodyStyle = { padding: 10, display: "flex", flexDirection: "column", gap: 8 };

			return function ConfigPage() {
				const state = useStore(store);
				const [editor, setEditor] = useState(null);
				const [transfer, setTransfer] = useState("");
				const definitions = store.defs();
				const builtins = definitions.filter((def) => def.builtin);
				const customs = definitions.filter((def) => !def.builtin);
				const routes = state.routes;
				const limits = state.limits || {};
				const busy = state.running === true;

				const openEditor = (def) => setEditor({
					id: def ? def.id : null,
					name: def ? def.name : "",
					prompt: def ? def.prompt : "",
					route: def ? def.route : null,
				});

				/** One row per module: its name, its route, and the prompt it will send. */
				const moduleRow = (def) => h("div", {
					key: def.id,
					style: {
						border: `1px solid ${C.border1}`,
						borderRadius: 8,
						padding: "8px 10px",
						display: "flex",
						flexDirection: "column",
						gap: 6,
					},
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 12, fontWeight: 600 } }, def.name),
						h("span", { style: hintStyle }, def.route
							? `${def.route.provider} / ${def.route.model}`
							: t("flow.followDefault")),
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", {
							type: "button",
							style: buttonStyle("ghost", !busy),
							disabled: busy,
							onClick: () => openEditor(def),
						}, t("editor.edit")),
						def.builtin
							? h("button", {
								type: "button",
								style: buttonStyle("ghost", !busy && def.prompt !== def.builtinPrompt),
								disabled: busy || def.prompt === def.builtinPrompt,
								onClick: () => store.resetModulePrompt(def.id),
							}, t("editor.resetPrompt"))
							: h("button", {
								type: "button",
								style: buttonStyle("danger", !busy),
								disabled: busy,
								onClick: () => store.deleteModule(def.id),
							}, t("editor.delete")),
					),
					h("div", {
						style: {
							...monoStyle,
							maxHeight: 78,
							overflow: "auto",
							whiteSpace: "pre-wrap",
							color: C.textDim,
						},
					}, def.prompt),
				);

				return h("div", { style: panelStyle },
					// ── header ──
					h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 14, fontWeight: 600 } }, t("config.title")),
						h("span", { style: { fontSize: 11, color: C.textDim } }, t("config.subtitle")),
						h("span", { style: { flex: "1 1 auto" } }),
						h("button", {
							type: "button",
							style: buttonStyle("ghost", !busy),
							disabled: busy,
							onClick: () => store.loadRoutes(),
						}, t("route.reload")),
					),

					state.notice
						? h("div", {
							style: {
								fontSize: 11,
								color: state.notice.kind === "error" ? C.error : state.notice.kind === "ok" ? C.success : C.textDim,
							},
							role: "status",
							"aria-live": "polite",
						}, state.notice.text)
						: null,

					h("div", {
						style: {
							flex: "1 1 auto",
							minHeight: 0,
							overflow: "auto",
							display: "flex",
							flexDirection: "column",
							gap: 8,
							paddingRight: 2,
						},
					},
						// ── default model ──
						h("div", { style: sectionStyle },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("config.defaultTitle")),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: hintStyle }, routes && routes.current
									? t("config.current", { provider: routes.current.provider, model: routes.current.model })
									: t("config.agentDefault")),
							),
							h("div", { style: sectionBodyStyle },
								h("div", { style: { fontSize: 11, color: C.textDim, lineHeight: 1.6 } }, t("config.defaultHint")),
								h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
									h("div", { style: { flex: "1 1 240px", minWidth: 180 } },
										h(RoutePicker, {
											store,
											route: state.doc.defaultRoute,
											onChange: (route) => store.setDefaultRoute(route),
											disabled: busy,
										}),
									),
									h("button", {
										type: "button",
										style: buttonStyle("ghost", !busy && !state.testing),
										disabled: busy || state.testing,
										onClick: () => store.testRoute(null),
									}, state.testing ? t("config.testing") : t("config.test")),
								),
								state.testResult
									? h("div", {
										style: { fontSize: 11, color: state.testResult.ok ? C.success : C.error },
									}, state.testResult.text)
									: null,
							),
						),

						// ── built-in modules ──
						h("div", { style: sectionStyle },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("config.builtinTitle")),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: hintStyle }, t("config.builtinHint")),
							),
							h("div", { style: sectionBodyStyle },
								builtins.length > 0
									? builtins.map(moduleRow)
									: h("div", { style: { fontSize: 11, color: C.textFaint } }, t("route.loading")),
							),
						),

						// ── custom modules ──
						h("div", { style: sectionStyle },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("config.customTitle")),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: hintStyle }, t("config.customHint")),
							),
							h("div", { style: sectionBodyStyle },
								customs.length > 0
									? customs.map(moduleRow)
									: h("div", { style: { fontSize: 11, color: C.textFaint } }, t("config.customEmpty")),
								h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
									h("button", {
										type: "button",
										style: buttonStyle("primary", !busy),
										disabled: busy,
										onClick: () => openEditor(null),
									}, t("editor.create")),
									customs.length > 0
										? h("button", {
											type: "button",
											style: buttonStyle("danger", !busy),
											disabled: busy,
											onClick: () => store.clearCustomModules(),
										}, t("config.clearCustom"))
										: null,
								),
							),
						),

						// ── portable configuration ──
						h("div", { style: sectionStyle },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("config.transferTitle")),
								h("span", { style: { flex: "1 1 auto" } }),
								h("span", { style: hintStyle }, t("config.transferHint")),
							),
							h("div", { style: sectionBodyStyle },
								h("textarea", {
									style: { ...monoStyle, minHeight: 92, resize: "vertical" },
									value: transfer,
									placeholder: t("config.importPlaceholder"),
									spellCheck: false,
									"aria-label": t("config.transferTitle"),
									onChange: (event) => setTransfer(event.target.value),
								}),
								h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
									h("button", {
										type: "button",
										style: buttonStyle("ghost", !busy),
										disabled: busy,
										onClick: () => setTransfer(store.exportDoc()),
									}, t("config.export")),
									h("button", {
										type: "button",
										style: buttonStyle("ghost", !busy && isText(transfer)),
										disabled: busy || !isText(transfer),
										onClick: () => {
											store.importDoc(transfer);
											setTransfer("");
										},
									}, t("config.importApply")),
								),
							),
						),

						// ── isolation ──
						h("div", { style: sectionStyle },
							h("div", { style: cardHeadStyle },
								h("span", { style: sectionTitleStyle }, t("config.isolationTitle")),
							),
							h("div", {
								style: { ...sectionBodyStyle, fontSize: 11, color: C.textDim, lineHeight: 1.7 },
							},
								h("div", null, t("config.isolationBody")),
								h("div", { style: monoStyle },
									t("config.isolationKeys", {
										keys: state.allowedRunKeys.length > 0 ? state.allowedRunKeys.join(", ") : "—",
									})),
								h("div", null, t("config.limits", {
									input: limits.maxInputChars ?? "—",
									prompt: limits.maxPromptChars ?? "—",
									timeout: typeof limits.timeoutMs === "number" ? Math.round(limits.timeoutMs / 1000) : "—",
								})),
							),
						),
					),

					editor
						? h(ModuleEditor, {
							key: editor.id ?? "new",
							store,
							draft: editor,
							onClose: () => setEditor(null),
						})
						: null,
				);
			};
		}

		/** Sidebar glyph for the flow page: a short node chain. */
		function FlowIcon({ size }) {
			const dimension = typeof size === "number" ? size : 16;
			return h("svg", {
				width: dimension,
				height: dimension,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
				h("rect", { x: 4.6, y: 1.6, width: 6.8, height: 3.4, rx: 1.1 }),
				h("rect", { x: 4.6, y: 6.3, width: 6.8, height: 3.4, rx: 1.1 }),
				h("rect", { x: 4.6, y: 11, width: 6.8, height: 3.4, rx: 1.1 }),
				h("path", { d: "M8 5v1.3M8 9.7V11" }),
			);
		}

		/**
		 * Mount the host namespace, then occupy the shell's slots.
		 *
		 * Awaiting `$mount` before registering slots means the pages can assume the
		 * `remote.translateFlow` namespace exists; a mount failure surfaces as a
		 * plugin activation error instead of a confusing empty panel.
		 *
		 * Every registration is returned as one cleanup, as the authoring guide
		 * requires of anything registered inside `apply`. The pages deliberately do
		 * not select themselves: the shell owns navigation, and a plugin that
		 * switches the main column on load would take the user's view away from
		 * whatever they were reading.
		 * @param ctx - the client plugin context.
		 * @returns the cleanup that releases every registration above.
		 */
		async function apply(ctx) {
			let unmountRemote;
			try {
				unmountRemote = await ctx.remote.$mount(REMOTE_CONTRIBUTION);
			} catch (error) {
				// Surface a readable reason in the plugin list instead of a bare
				// "failed to import" activation error.
				throw new Error(`translate-flow: mounting the "translateFlow" Remote namespace failed: ${error && error.message ? error.message : String(error)}`);
			}

			// Point the panel's own strings at the shell's locale before anything is
			// registered, so the sidebar labels already resolve in the active language.
			const disposeLocale = installLocale(ctx);
			const disposeStyles = installStyles();

			const store = createStore(ctx);
			store.loadRoster();

			const FlowPage = createFlowPage(ctx, store);
			const ConfigPage = createConfigPage(ctx, store);

			const disposeFlowPanel = ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_FLOW,
			}, FlowPage));

			const disposeFlowIcon = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_FLOW,
				order: 30,
				label: () => t("nav.flow"),
			}, FlowIcon));

			// A second panel rather than a mode of the first: the sidebar addresses a
			// main panel by its own list id, so two ids is exactly what gives the user
			// two entries and two independently addressable pages.
			const disposeConfigPanel = ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_CONFIG,
			}, ConfigPage));

			const disposeConfigIcon = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_CONFIG,
				order: 31,
				label: () => t("nav.config"),
			}, ConfigIcon));

			return () => {
				// Reverse of registration order; each step is independently tolerant,
				// because the fiber may already have released some of them.
				for (const dispose of [
					disposeConfigIcon,
					disposeConfigPanel,
					disposeFlowIcon,
					disposeFlowPanel,
					unmountRemote,
					disposeLocale,
					disposeStyles,
				]) {
					try {
						if (typeof dispose === "function") dispose();
					} catch {
						/* already released */
					}
				}
				// Last, so no registration handler can still be notified.
				try {
					store.dispose();
				} catch {
					/* the store is already released */
				}
			};
		}

		const inject = ["remote", "slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
