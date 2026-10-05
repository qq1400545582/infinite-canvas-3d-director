import assert from "node:assert/strict";
import { test } from "node:test";

import { createChatStreamTranslator, createToolNameResolver, normalizeUpstreamTools, responsesToChatRequest, stripReasoningItems } from "./codex-upstream-proxy.js";

test("namespace 工具会被拍平为顶层 function 并加前缀", () => {
    const { tools, flattened, dropped } = normalizeUpstreamTools([
        { type: "function", name: "shell_command" },
        { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "close_agent" }, { type: "function", name: "spawn_agent" }] },
    ]);
    assert.equal(flattened, 2);
    assert.equal(dropped, 0);
    assert.deepEqual(tools.map((tool) => tool.name), ["shell_command", "multi_agent_v1__close_agent", "multi_agent_v1__spawn_agent"]);
    // 拍平后不应残留 tools 嵌套字段
    assert.equal("tools" in tools[1], false);
});

test("web_search 会被改写为上游接受的 web_search_preview", () => {
    const { tools, rewritten } = normalizeUpstreamTools([{ type: "function", name: "shell_command" }, { type: "web_search", external_web_access: false }]);
    assert.equal(rewritten, 1);
    assert.deepEqual(tools[1], { type: "web_search_preview" });
});

test("上游已支持的形态原样保留", () => {
    const { tools, rewritten, flattened, dropped } = normalizeUpstreamTools([
        { type: "function", name: "shell_command" },
        { type: "web_search_preview" },
        { type: "code_interpreter" },
        { type: "mcp", name: "server" },
    ]);
    assert.equal(tools.length, 4);
    assert.equal(rewritten + flattened + dropped, 0);
    assert.deepEqual(tools[1], { type: "web_search_preview" });
});

test("未知工具类型被丢弃而不是让整轮失败", () => {
    const { tools, dropped } = normalizeUpstreamTools([{ type: "function", name: "shell_command" }, { type: "future_unknown_tool" }]);
    assert.equal(dropped, 1);
    assert.equal(tools.length, 1);
});

test("namespace 内非 function 子项被丢弃", () => {
    const { tools, flattened, dropped } = normalizeUpstreamTools([{ type: "namespace", name: "ns", tools: [{ type: "function", name: "a" }, { type: "web_search" }] }]);
    assert.equal(flattened, 1);
    assert.equal(dropped, 1);
    assert.deepEqual(tools.map((tool) => tool.name), ["ns__a"]);
});

test("reasoning 输入条目会被剔除，message 条目保持原样", () => {
    const input = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "思考" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ];
    const { input: kept, removed } = stripReasoningItems(input);
    assert.equal(removed, 1);
    assert.equal((kept as unknown[]).length, 2);
    assert.deepEqual((kept as Array<{ type: string }>).map((item) => item.type), ["message", "message"]);
});

test("非数组 input 原样返回", () => {
    assert.deepEqual(stripReasoningItems("hello"), { input: "hello", removed: 0 });
    assert.deepEqual(stripReasoningItems(undefined), { input: undefined, removed: 0 });
});

/* ------------------------------------------------------------------ *
 * Responses → Chat Completions 桥接
 * ------------------------------------------------------------------ */

test("桥接：instructions 变 system、developer 变 system、纯文本 content 用字符串", () => {
    const { chat, images } = responsesToChatRequest(
        {
            model: "m",
            instructions: "you are a coding agent",
            input: [
                { type: "message", role: "developer", content: [{ type: "input_text", text: "权限说明" }] },
                { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
            ],
        },
        "m"
    );
    const messages = chat.messages as Array<{ role: string; content: unknown }>;
    assert.equal(images, 0);
    assert.deepEqual(messages.map((m) => m.role), ["system", "system", "user"]);
    assert.equal(messages[1].content, "权限说明");
    assert.equal(messages[2].content, "你好");
    assert.equal(chat.stream, true);
    assert.deepEqual(chat.stream_options, { include_usage: true });
});

test("桥接：input_image 变 image_url，且与文本混排时保留数组形态", () => {
    const { chat, images } = responsesToChatRequest(
        {
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "看图" },
                        { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" },
                    ],
                },
            ],
        },
        "m"
    );
    const messages = chat.messages as Array<{ content: unknown }>;
    assert.equal(images, 1);
    assert.deepEqual(messages[0].content, [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "high" } },
    ]);
});

test("桥接：函数调用与结果归位成 tool_calls / tool 消息", () => {
    const { chat, dropped } = responsesToChatRequest(
        {
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: "跑一下" }] },
                { type: "function_call", call_id: "call_1", name: "shell_command", arguments: '{"command":"echo hi"}' },
                { type: "function_call_output", call_id: "call_1", output: "hi\n" },
            ],
        },
        "m"
    );
    const messages = chat.messages as Array<Record<string, unknown>>;
    assert.equal(dropped, 0);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool"]);
    assert.equal(messages[1].content, null);
    assert.deepEqual(messages[1].tool_calls, [{ id: "call_1", type: "function", function: { name: "shell_command", arguments: '{"command":"echo hi"}' } }]);
    assert.deepEqual(messages[2], { role: "tool", tool_call_id: "call_1", content: "hi\n" });
});

test("桥接：reasoning 条目被跳过，缺失 call_id 的函数调用计入 dropped", () => {
    const { dropped } = responsesToChatRequest(
        {
            input: [
                { type: "reasoning", id: "rs_1" },
                { type: "function_call", name: "shell_command", arguments: "{}" },
                { type: "future_unknown" },
            ],
        },
        "m"
    );
    assert.equal(dropped, 2);
});

test("桥接：tools 由 Responses 平铺形状包成 chat 形状，非 function 类型被丢弃", () => {
    const { chat } = responsesToChatRequest(
        {
            tools: [
                { type: "function", name: "ns__a", description: "d", parameters: { type: "object" }, strict: false },
                { type: "web_search_preview" },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
        },
        "m"
    );
    assert.deepEqual(chat.tools, [{ type: "function", function: { name: "ns__a", description: "d", parameters: { type: "object" }, strict: false } }]);
    assert.equal(chat.tool_choice, "auto");
    assert.equal(chat.parallel_tool_calls, false);
});

test("桥接：没有工具时不带 tool_choice（上游会因 tools 为空而 400）", () => {
    const { chat } = responsesToChatRequest({ tools: [], tool_choice: "auto" }, "m");
    assert.equal("tool_choice" in chat, false);
    assert.equal("tools" in chat, false);
});

/** 把 responses 事件流解析成对象数组。 */
function parseEvents(sse: string): Array<Record<string, unknown>> {
    return sse
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

test("桥接：文本增量被翻译成 responses 事件与最终 output", () => {
    const translator = createChatStreamTranslator({ model: "m" });
    let out = translator.push('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');
    out += translator.push('data: {"choices":[{"delta":{"content":"你好"}}]}\n');
    out += translator.push('\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n');
    out += translator.finish();
    const events = parseEvents(out);
    assert.deepEqual(
        events.map((event) => event.type),
        [
            "response.created",
            "response.in_progress",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.completed",
        ]
    );
    const completed = events[events.length - 1].response as Record<string, unknown>;
    assert.equal(completed.status, "completed");
    const output = completed.output as Array<Record<string, unknown>>;
    assert.equal(output.length, 1);
    assert.equal(output[0].type, "message");
    assert.equal((output[0].content as Array<Record<string, unknown>>)[0].text, "你好世界");
    assert.deepEqual(completed.usage, {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
    });
    // 幂等
    assert.equal(translator.finish(), "");
});

test("桥接：function_call 增量被翻译成 function_call_arguments 事件", () => {
    const translator = createChatStreamTranslator({ model: "m" });
    let out = translator.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell_command","arguments":""}}]}}]}\n\n');
    out += translator.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"echo hi\\"}"}}]}}]}\n\n');
    out += translator.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    out += translator.finish();
    const events = parseEvents(out);
    assert.deepEqual(
        events.map((event) => event.type),
        ["response.created", "response.in_progress", "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]
    );
    const added = events[2].item as Record<string, unknown>;
    assert.equal(added.type, "function_call");
    assert.equal(added.call_id, "call_9");
    assert.equal(added.name, "shell_command");
    const completed = events[events.length - 1].response as Record<string, unknown>;
    const output = completed.output as Array<Record<string, unknown>>;
    assert.equal(output[0].type, "function_call");
    assert.equal(output[0].call_id, "call_9");
    assert.equal(output[0].arguments, '{"command":"echo hi"}');
    assert.equal(translator.hasContent(), true);
});

test("桥接：上游中途失败也会收尾（failed + completed），不把 Codex 卡住", () => {
    const translator = createChatStreamTranslator({ model: "m" });
    const out = translator.failed("连接被重置");
    const events = parseEvents(out);
    assert.deepEqual(events.map((event) => event.type), ["response.created", "response.in_progress", "response.failed", "response.completed"]);
    assert.equal((events[2].response as Record<string, unknown>).status, "failed");
    assert.equal(parseEvents(translator.finish()).length, 0);
});

/* ------------------------------------------------------------------ *
 * 工具名纠偏（免费模型把 mcp__<server>__tool 的连字符规范成下划线）
 * ------------------------------------------------------------------ */

const CANVAS_TOOLS = new Set([
    "mcp__infinite-canvas__canvas_get_state",
    "mcp__infinite-canvas__canvas_apply_ops",
    "mcp__infinite-canvas__site_navigate",
    "shell_command",
]);

test("纠偏：下划线拼写的 mcp 工具名改写为 canonical（2026-10-02 实测失败场景）", () => {
    const resolve = createToolNameResolver(CANVAS_TOOLS);
    assert.equal(resolve("mcp__infinite_canvas__canvas_get_state"), "mcp__infinite-canvas__canvas_get_state");
    assert.equal(resolve("mcp__infinite_canvas__canvas_apply_ops"), "mcp__infinite-canvas__canvas_apply_ops");
    assert.equal(resolve("mcp__infinite_canvas__site_navigate"), "mcp__infinite-canvas__site_navigate");
});

test("纠偏：精确命中与普通工具保持原样", () => {
    const resolve = createToolNameResolver(CANVAS_TOOLS);
    assert.equal(resolve("mcp__infinite-canvas__canvas_get_state"), "mcp__infinite-canvas__canvas_get_state");
    assert.equal(resolve("shell_command"), "shell_command");
});

test("纠偏：AGENTS.md 裸名指令（无 mcp__ 前缀）唯一命中时改写", () => {
    const resolve = createToolNameResolver(CANVAS_TOOLS);
    assert.equal(resolve("canvas_get_state"), "mcp__infinite-canvas__canvas_get_state");
    assert.equal(resolve("site_navigate"), "mcp__infinite-canvas__site_navigate");
});

test("纠偏：未知工具名与歧义匹配保持原样", () => {
    const resolve = createToolNameResolver(CANVAS_TOOLS);
    assert.equal(resolve("canvas_get_state_extra"), "canvas_get_state_extra");
    assert.equal(resolve("totally_bogus_tool"), "totally_bogus_tool");
    // 歧义：两个 canonical 裸名归一后相同 → 不改写
    const ambiguous = createToolNameResolver(new Set(["mcp__a__my_tool", "mcp__a-b__my_tool"]));
    assert.equal(ambiguous("my_tool"), "my_tool");
});

test("纠偏：空清单时恒等", () => {
    const resolve = createToolNameResolver(new Set());
    assert.equal(resolve("mcp__infinite_canvas__canvas_get_state"), "mcp__infinite_canvas__canvas_get_state");
});

test("桥接：agnes 发出的下划线工具名在事件流里被改写为 canonical", () => {
    const translator = createChatStreamTranslator({ model: "m", toolNames: CANVAS_TOOLS });
    let out = translator.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"mcp__infinite_canvas__canvas_get_state","arguments":""}}]}}]}\n\n');
    out += translator.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n');
    out += translator.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    out += translator.finish();
    const events = parseEvents(out);
    const added = events[2].item as Record<string, unknown>;
    assert.equal(added.type, "function_call");
    assert.equal(added.name, "mcp__infinite-canvas__canvas_get_state");
    const completed = events[events.length - 1].response as Record<string, unknown>;
    const output = completed.output as Array<Record<string, unknown>>;
    assert.equal(output[0].name, "mcp__infinite-canvas__canvas_get_state");
});

test("桥接：未提供 toolNames 时工具名保持原样（向后兼容）", () => {
    const translator = createChatStreamTranslator({ model: "m" });
    let out = translator.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"some_tool","arguments":""}}]}}]}\n\n');
    out += translator.finish();
    const events = parseEvents(out);
    const added = events[2].item as Record<string, unknown>;
    assert.equal(added.name, "some_tool");
});
