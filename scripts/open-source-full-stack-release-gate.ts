import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface ReleaseGateStep {
  readonly label: string;
  readonly run: () => Promise<void> | void;
}

const root = process.cwd();
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

const staleNeedles = [
  ["MEMORY", "V2"].join("_"),
  ["api", "memory", "v2"].join("/"),
  ["Memory", "v2"].join("-"),
  ["memory", "v2"].join("-"),
  ["openclaw", "memory", "xx", "wrapper"].join("-"),
];

function envEnabled(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function runNpm(script: string, extraArgs: readonly string[] = []): void {
  const args = ["run", script, ...extraArgs];
  process.stdout.write(`\n$ npm ${args.join(" ")}\n`);
  const result = spawnSync(npmBin, args, {
    cwd: root,
    env: {
      ...process.env,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`release gate step failed: npm ${args.join(" ")}`);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(root, fullPath).replace(/\\/gu, "/");
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...await listFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (relative === "package-lock.json") continue;
    files.push(fullPath);
  }
  return files.sort();
}

async function assertNoStalePublicCompatibilityNames(): Promise<void> {
  const hits: string[] = [];
  for (const file of await listFiles(root)) {
    const relative = path.relative(root, file).replace(/\\/gu, "/");
    const info = await stat(file);
    if (info.size > 2 * 1024 * 1024) continue;
    let content = "";
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const needle of staleNeedles) {
      if (!content.includes(needle)) continue;
      if (relative === "tests/open-source-readiness.test.ts") continue;
      hits.push(`${relative}: stale public compatibility name ${needle}`);
    }
  }

  if (hits.length > 0) {
    throw new Error(`stale public compatibility name scan failed:\n${hits.join("\n")}`);
  }
  process.stdout.write("stale public compatibility name scan: ok\n");
}

function buildSteps(): ReleaseGateStep[] {
  const steps: ReleaseGateStep[] = [
    {
      label: "typecheck",
      run: () => runNpm("typecheck"),
    },
    {
      label: "unit and contract tests",
      run: () => runNpm("test"),
    },
    {
      label: "public open-source readiness",
      run: () => runNpm("verify:open-source"),
    },
    {
      label: "migration order",
      run: () => runNpm("check:migrations"),
    },
    {
      label: "hardcoded path scan",
      run: () => runNpm("check:hardcoded-paths"),
    },
    {
      label: "stale public compatibility name scan",
      run: assertNoStalePublicCompatibilityNames,
    },
  ];

  const referenceRoot = process.env.MEMORY_XX_PARITY_REFERENCE_ROOT?.trim();
  if (referenceRoot) {
    steps.push({
      label: "reference parity audit",
      run: () => runNpm("open-source:parity-audit", ["--", "--reference-root", referenceRoot, "--json"]),
    });
  } else if (envEnabled("MEMORY_XX_RELEASE_GATE_REQUIRE_PARITY")) {
    steps.push({
      label: "reference parity audit",
      run: () => {
        throw new Error("MEMORY_XX_PARITY_REFERENCE_ROOT is required when MEMORY_XX_RELEASE_GATE_REQUIRE_PARITY=1");
      },
    });
  } else {
    process.stdout.write("Skipping npm run open-source:parity-audit because MEMORY_XX_PARITY_REFERENCE_ROOT is unset.\n");
  }

  if (envEnabled("MEMORY_XX_RELEASE_GATE_SKIP_COMPOSE")) {
    process.stdout.write("Skipping compose release smokes because MEMORY_XX_RELEASE_GATE_SKIP_COMPOSE=1.\n");
  } else {
    steps.push(
      {
        label: "enhanced compose smoke",
        run: () => runNpm("smoke:compose-enhanced"),
      },
      {
        label: "full compose smoke",
        run: () => runNpm("smoke:compose-full"),
      }
    );
  }

  return steps;
}

async function main(): Promise<void> {
  const started = new Date().toISOString();
  process.stdout.write(`memory-xx full-stack open-source release gate started at ${started}\n`);
  for (const step of buildSteps()) {
    process.stdout.write(`\n==> ${step.label}\n`);
    await step.run();
  }
  process.stdout.write("\nmemory-xx full-stack open-source release gate: ok\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`memory-xx full-stack open-source release gate: failed\n${message}\n`);
  process.exitCode = 1;
});
