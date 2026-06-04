import { promises as fs } from "node:fs";
import path from "node:path";

import { PROJECTION_VIEW_DIRECTORIES, PROJECTION_ROOT_DIR } from "./constants";
import { ProjectionView } from "./types";

export interface ValidationCheckResult {
  readonly passed: boolean;
  readonly checks: readonly ValidationCheck[];
}

export interface ValidationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message?: string;
}

/**
 * Smoke-check that the projection root directory has the expected
 * layout: 7 canonical view directories exist, each with an index.md.
 *
 * Governance boundary: confirm governance/ exists but is marked internal.
 */
export async function validateProjectionLayout(
  rootDir: string = PROJECTION_ROOT_DIR
): Promise<ValidationCheckResult> {
  const checks: ValidationCheck[] = [];

  // Check root exists
  const rootExists = await dirExists(rootDir);
  checks.push({
    name: "root_exists",
    passed: rootExists,
    message: rootExists ? undefined : `Projection root ${rootDir} does not exist`
  });

  if (!rootExists) {
    return { passed: false, checks };
  }

  // Check 7 canonical view directories
  for (const [view, dirName] of Object.entries(PROJECTION_VIEW_DIRECTORIES)) {
    const viewDir = path.join(rootDir, dirName);
    const exists = await dirExists(viewDir);
    checks.push({
      name: `view_dir_${view}`,
      passed: exists,
      message: exists ? undefined : `View directory ${viewDir} missing`
    });

    // Check index.md exists in each view
    const indexPath = path.join(viewDir, "index.md");
    const indexExists = await fileExists(indexPath);
    checks.push({
      name: `view_index_${view}`,
      passed: indexExists,
      message: indexExists ? undefined : `Index file ${indexPath} missing`
    });

    // Governance boundary: index.md should contain visibility: internal
    if (view === ProjectionView.Governance && indexExists) {
      const content = await fs.readFile(indexPath, "utf8").catch(() => "");
      const hasInternal = content.includes("internal");
      checks.push({
        name: "governance_visibility_internal",
        passed: hasInternal,
        message: hasInternal ? undefined : "governance/index.md missing visibility: internal"
      });
    }
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function dirExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
