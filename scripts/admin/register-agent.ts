#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const MEMORY_AGENT_SCRIPT = "scripts/memory-agent.ts";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

function csv(name: string): string[] {
  return arg(name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseScopes(): string[] {
  const fromAllowedScopes = csv("allowed-scopes");
  const fromScopes = csv("scopes");
  const scopes = [...fromAllowedScopes, ...fromScopes];
  if (scopes.length === 0) throw new Error("Missing --allowed-scopes=project:alpha[,workspace:team].");
  for (const scope of scopes) {
    if (!/^(user|project|workspace|global):[^:]+(?::.*)?$/u.test(scope)) {
      throw new Error(`Invalid scope '${scope}'. Use <scope_type>:<scope_id>.`);
    }
  }
  return [...new Set(scopes)];
}

function parsePermissions(): string {
  const permissions = csv("permissions");
  const values = permissions.length > 0 ? permissions : ["memory:read", "memory:write", "memory:feedback"];
  return [...new Set(values)].join(",");
}

function runMemoryAgent(args: readonly string[]): Record<string, unknown> {
  const result = spawnSync("node", ["--import", "tsx", MEMORY_AGENT_SCRIPT, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error([
      `memory-agent ${args.join(" ")} failed`,
      result.stderr.trim(),
      result.stdout.trim(),
    ].filter(Boolean).join("\n"));
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function createArgs(input: {
  readonly agentId: string;
  readonly projectScopeId: string | null;
  readonly expiresAt: string;
  readonly envFile: string;
  readonly rotate: boolean;
}): string[] {
  return [
    "create",
    input.agentId,
    ...(input.projectScopeId ? [`--project=${input.projectScopeId}`] : []),
    ...(input.expiresAt ? [`--expires-at=${input.expiresAt}`] : []),
    ...(input.envFile ? [`--env-file=${input.envFile}`] : []),
    ...(input.rotate ? ["--rotate"] : []),
  ];
}

async function main(): Promise<void> {
  const agentId = arg("agent-name") || arg("agent-id");
  if (!agentId) throw new Error("Missing --agent-name=<agent_id>.");
  const scopes = parseScopes();
  const permissions = parsePermissions();
  const expiresAt = arg("expires-at");
  const envFile = arg("env-file");
  const rotate = process.argv.includes("--rotate");
  const firstProjectScope = scopes
    .map((scope) => {
      const [scopeType, ...scopeId] = scope.split(":");
      return scopeType === "project" ? scopeId.join(":") : "";
    })
    .find(Boolean) ?? null;

  const created = runMemoryAgent(createArgs({
    agentId,
    projectScopeId: firstProjectScope,
    expiresAt,
    envFile,
    rotate,
  }));
  const grants = scopes.map((scope) => runMemoryAgent([
    "grant",
    agentId,
    `--scope=${scope}`,
    `--permissions=${permissions}`,
    ...(expiresAt ? [`--expires-at=${expiresAt}`] : []),
  ]));

  process.stdout.write(JSON.stringify({
    ok: true,
    registration_id: randomUUID(),
    agent_id: agentId,
    scopes,
    permissions: permissions.split(","),
    trusted_agent: created.trusted_agent ?? null,
    grants,
    token: created.token ?? null,
    env_file: created.env_file ?? envFile || null,
    env_snippet: created.env_snippet ?? null,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
