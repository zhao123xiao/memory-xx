import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolRegistry, ResourceRegistry } from "../app/mcp/tool-registry";

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: "test_tool", description: "A test tool", inputSchema: { type: "object" } },
      async () => ({ ok: true })
    );
    const list = reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "test_tool");
    assert.equal(list[0].description, "A test tool");
  });

  it("has returns true for registered tool", () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: "my_tool", description: "", inputSchema: { type: "object" } },
      async () => null
    );
    assert.equal(reg.has("my_tool"), true);
    assert.equal(reg.has("other"), false);
  });

  it("calls handler with args", async () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: "add", description: "", inputSchema: { type: "object" } },
      async (args) => ({ sum: Number(args.a) + Number(args.b) })
    );
    const result = await reg.call("add", { a: 3, b: 4 });
    assert.deepEqual(result, { sum: 7 });
  });

  it("throws on unknown tool call", async () => {
    const reg = new ToolRegistry();
    await assert.rejects(
      () => reg.call("missing", {}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Tool not found"));
        return true;
      }
    );
  });

  it("handles multiple tools", () => {
    const reg = new ToolRegistry();
    reg.register({ name: "a", description: "A", inputSchema: { type: "object" } }, async () => "a");
    reg.register({ name: "b", description: "B", inputSchema: { type: "object" } }, async () => "b");
    assert.equal(reg.list().length, 2);
    assert.equal(reg.has("a"), true);
    assert.equal(reg.has("b"), true);
  });
});

describe("ResourceRegistry", () => {
  it("registers and lists resources", () => {
    const reg = new ResourceRegistry();
    reg.register(
      { uri: "memory://health", name: "Health" },
      async () => ({ content: "ok" })
    );
    const list = reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].uri, "memory://health");
  });

  it("has returns correct boolean", () => {
    const reg = new ResourceRegistry();
    reg.register({ uri: "x://y", name: "Y" }, async () => ({ content: "" }));
    assert.equal(reg.has("x://y"), true);
    assert.equal(reg.has("x://z"), false);
  });

  it("reads resource content", async () => {
    const reg = new ResourceRegistry();
    reg.register(
      { uri: "test://data", name: "Data", mimeType: "text/plain" },
      async () => ({ content: "hello world", mimeType: "text/plain" })
    );
    const result = await reg.read("test://data");
    assert.equal(result.content, "hello world");
    assert.equal(result.mimeType, "text/plain");
  });

  it("throws on unknown resource", async () => {
    const reg = new ResourceRegistry();
    await assert.rejects(
      () => reg.read("missing://"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Resource not found"));
        return true;
      }
    );
  });
});
