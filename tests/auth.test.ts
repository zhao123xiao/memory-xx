import assert from "node:assert/strict";
import test from "node:test";
import { createAuthChecker } from "../app/server/auth";

function makeReq(headers: Record<string, string> = {}): any {
  return { headers };
}

test("auth checker rejects request with no Authorization header when token is configured", () => {
  const auth = createAuthChecker({ MEMORY_XX_API_TOKEN: "secret-key-123" });
  assert.equal(auth.isAuthEnabled(), true);
  assert.equal(auth.isAuthenticated(makeReq()), false);
});

test("auth checker accepts request with valid Bearer token", () => {
  const auth = createAuthChecker({ MEMORY_XX_API_TOKEN: "secret-key-123" });
  assert.equal(
    auth.isAuthenticated(makeReq({ authorization: "Bearer secret-key-123" })),
    true,
  );
});

test("auth checker rejects request with wrong Bearer token", () => {
  const auth = createAuthChecker({ MEMORY_XX_API_TOKEN: "secret-key-123" });
  assert.equal(
    auth.isAuthenticated(makeReq({ authorization: "Bearer wrong-token" })),
    false,
  );
});

test("auth checker accepts request with valid X-API-Key header", () => {
  const auth = createAuthChecker({ MEMORY_XX_API_TOKEN: "secret-key-123" });
  assert.equal(
    auth.isAuthenticated(makeReq({ "x-api-key": "secret-key-123" })),
    true,
  );
});

test("auth checker allows all requests when MEMORY_XX_API_TOKEN is empty (dev mode)", () => {
  const auth = createAuthChecker({ MEMORY_XX_API_TOKEN: "" });
  assert.equal(auth.isAuthEnabled(), false);
  assert.equal(auth.isAuthenticated(makeReq()), true);
  assert.equal(auth.isAuthenticated(makeReq({ authorization: "Bearer anything" })), true);
});
