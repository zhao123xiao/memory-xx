import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { scanTextForSecrets } from "../scripts/secret-scan";

test("secret scan allows explicitly marked test fixture secrets on the same line", () => {
  const findings = scanTextForSecrets(
    "ci.yml",
    "MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@memory-xx-postgres:5432/memory_v2 # memory-xx-secret-scan: allow-test-fixture\n"
  );

  assert.deepEqual(findings, []);
});

test("secret scan still reports unmarked bearer token literals", () => {
  const findings = scanTextForSecrets(
    "script.sh",
    `curl -H "Authorization: Bearer ${"3b8a6b50467290bbf7d3823aa723ad6119c7ac887d3624e6"}"\n`
  );

  assert.deepEqual(findings, [{
    file: "script.sh",
    line: 1,
    rule: "bearer-token-literal",
  }]);
});

test("secret scan allows local compose postgres URLs but blocks external postgres passwords", () => {
  assert.deepEqual(
    scanTextForSecrets("docker-compose.yml", "MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@postgres:5432/memory_xx\n"),
    []
  );
  assert.deepEqual(
    scanTextForSecrets("docker.yml", "MEMORY_XX_DATABASE_URL=postgres://postgres:postgres@memory-xx-postgres:5432/memory_xx\n"),
    []
  );
  const externalUrl = "DATABASE_URL=postgres://user" + ":pass@" + "db.example.com:5432/prod\n";
  assert.deepEqual(scanTextForSecrets("script.sh", externalUrl), [{
    file: "script.sh",
    line: 1,
    rule: "postgres-url-with-password",
  }]);
});

test(".env files are ignored and not tracked in the memory-xx repository", () => {
  const tracked = execFileSync("git", ["ls-files", "--", ".env", ".env.local", ".env.production"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  assert.equal(tracked, "");

  const ignored = execFileSync("git", ["check-ignore", ".env", ".env.local"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim().split(/\r?\n/u);
  assert.deepEqual(ignored, [".env", ".env.local"]);
});
