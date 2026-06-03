import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  successResponse,
  errorResponse,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "../app/mcp/protocol";

describe("MCP Protocol", () => {
  describe("parseMessage", () => {
    it("parses valid JSON-RPC request", () => {
      const msg = parseMessage('{"jsonrpc":"2.0","method":"ping","id":1}');
      assert.ok(msg);
      assert.equal(msg.method, "ping");
    });

    it("parsies request with params", () => {
      const msg = parseMessage('{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"test"}}');
      assert.ok(msg);
      assert.deepEqual(msg.params, { name: "test" });
    });

    it("parses notification (no id)", () => {
      const msg = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
      assert.ok(msg);
      assert.ok(isJsonRpcNotification(msg));
    });

    it("returns null for invalid JSON", () => {
      assert.equal(parseMessage("not json"), null);
    });

    it("returns null for missing jsonrpc field", () => {
      assert.equal(parseMessage('{"method":"ping","id":1}'), null);
    });

    it("returns null for missing method field", () => {
      assert.equal(parseMessage('{"jsonrpc":"2.0","id":1}'), null);
    });

    it("returns null for non-string method", () => {
      assert.equal(parseMessage('{"jsonrpc":"2.0","method":123,"id":1}'), null);
    });
  });

  describe("isJsonRpcRequest", () => {
    it("returns true for valid request", () => {
      assert.ok(isJsonRpcRequest({ jsonrpc: "2.0", method: "ping", id: 1 }));
    });

    it("returns false for null", () => {
      assert.equal(isJsonRpcRequest(null), false);
    });

    it("returns false for wrong jsonrpc version", () => {
      assert.equal(isJsonRpcRequest({ jsonrpc: "1.0", method: "ping", id: 1 }), false);
    });
  });

  describe("isJsonRpcNotification", () => {
    it("returns true when id is undefined", () => {
      assert.ok(isJsonRpcNotification({ jsonrpc: "2.0", method: "ping" }));
    });

    it("returns true when id is null", () => {
      assert.ok(isJsonRpcNotification({ jsonrpc: "2.0", method: "ping", id: null }));
    });

    it("returns false when id is present", () => {
      assert.equal(isJsonRpcNotification({ jsonrpc: "2.0", method: "ping", id: 1 }), false);
    });
  });

  describe("successResponse", () => {
    it("creates correct response", () => {
      const resp = successResponse(1, { tools: [] });
      assert.equal(resp.jsonrpc, "2.0");
      assert.equal(resp.id, 1);
      assert.deepEqual(resp.result, { tools: [] });
    });

    it("handles null id", () => {
      const resp = successResponse(null, {});
      assert.equal(resp.id, null);
    });
  });

  describe("errorResponse", () => {
    it("creates correct error response", () => {
      const resp = errorResponse(1, METHOD_NOT_FOUND, "not found");
      assert.equal(resp.jsonrpc, "2.0");
      assert.equal(resp.id, 1);
      assert.equal(resp.error.code, METHOD_NOT_FOUND);
      assert.equal(resp.error.message, "not found");
    });

    it("includes optional data", () => {
      const resp = errorResponse(1, INVALID_PARAMS, "bad params", { field: "name" });
      assert.deepEqual(resp.error.data, { field: "name" });
    });
  });

  describe("error codes", () => {
    it("has standard codes", () => {
      assert.equal(PARSE_ERROR, -32700);
      assert.equal(INVALID_REQUEST, -32600);
      assert.equal(METHOD_NOT_FOUND, -32601);
      assert.equal(INVALID_PARAMS, -32602);
      assert.equal(INTERNAL_ERROR, -32603);
    });
  });
});
