import { expect, test } from "bun:test";

import { PromptToolBridge } from "../../src/application/tools.ts";
import type { ToolDefinition } from "../../src/domain/chat.ts";

const tools: ToolDefinition[] = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

const bridge = new PromptToolBridge();
const allowed = ["a", "b", "c", "get_weather"];

test("instruction：包含工具名和 JSON 格式；无工具为空", () => {
  const text = bridge.instruction(tools, "auto");
  expect(text).toContain("get_weather");
  expect(text).toContain("tool_calls");
  expect(bridge.instruction([], "auto")).toBe("");
  expect(bridge.instruction(tools, { type: "function", function: { name: "get_weather" } }))
    .toContain("must call the tool \"get_weather\"");
});

test("instruction：tool_choice none 时返回空（H-12）", () => {
  expect(bridge.instruction(tools, "none")).toBe("");
});

test("parse：D1 整段信封 / fenced / D2 散文里唯一顶层信封", () => {
  expect(bridge.parse("{\"tool_calls\":[{\"name\":\"a\",\"arguments\":{\"x\":1}}]}", allowed))
    .toEqual({ calls: [{ name: "a", arguments: "{\"x\":1}" }] });
  expect(bridge.parse("```json\n{\"tool_calls\":[{\"name\":\"b\",\"arguments\":{}}]}\n```", allowed))
    .toEqual({ calls: [{ name: "b", arguments: "{}" }] });
  expect(bridge.parse("Sure.\n{\"tool_calls\":[{\"name\":\"c\",\"arguments\":{\"y\":2}}]}\nDone.", allowed))
    .toEqual({ calls: [{ name: "c", arguments: "{\"y\":2}" }] });
});

test("parse：普通文本 / 非工具 JSON / 单体对象 → null（H-12）", () => {
  expect(bridge.parse("pong", allowed)).toBeNull();
  expect(bridge.parse("{\"a\":1}", allowed)).toBeNull();
  // 单体 {name, arguments} 不再接受：只认 tool_calls 信封。
  expect(bridge.parse("{\"name\":\"a\",\"arguments\":\"{\\\"z\\\":3}\"}", allowed)).toBeNull();
});

test("parse：名字不在白名单 → 整次 null；白名单为空 → null（H-12）", () => {
  expect(bridge.parse("{\"tool_calls\":[{\"name\":\"evil\",\"arguments\":{}}]}", allowed)).toBeNull();
  expect(bridge.parse(
    "{\"tool_calls\":[{\"name\":\"a\",\"arguments\":{}},{\"name\":\"evil\",\"arguments\":{}}]}",
    allowed,
  )).toBeNull();
  expect(bridge.parse("{\"tool_calls\":[{\"name\":\"a\",\"arguments\":{}}]}", [])).toBeNull();
});

test("parse：全文两个顶层对象 → null（D2 要求恰好一个）", () => {
  expect(bridge.parse(
    "{\"tool_calls\":[{\"name\":\"a\",\"arguments\":{}}]} {\"tool_calls\":[{\"name\":\"b\",\"arguments\":{}}]}",
    allowed,
  )).toBeNull();
});
