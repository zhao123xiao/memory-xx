import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert';

function runScript(scriptPath: string, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--import', 'tsx', scriptPath, ...args], {
      env: { ...process.env, TMPDIR: '/tmp' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('memory-evolve-report (CLI integration)', () => {
  it('should exit 0 with --help', async () => {
    const result = await runScript('scripts/memory-evolve.ts', ['--help']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Memory Evolve Report'));
    assert.ok(result.stdout.includes('Sections'));
  });

  it('should generate aggregated report with no data', async () => {
    const result = await runScript('scripts/memory-evolve.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Memory Evolve Report'));
    assert.ok(result.stdout.includes('Summary:'));
    assert.ok(result.stdout.includes('Total action candidates: 0'));
  });

  it('should list all module names in help', async () => {
    const result = await runScript('scripts/memory-evolve.ts', ['--help']);
    assert.strictEqual(result.code, 0);
    const expectedModules = [
      'stale_facts',
      'consolidation',
      'context_hygiene',
      'graph_repair',
      'adaptive_calibration',
      'procedural_promotion',
      'recall_feedback',
      'extraction_recall',
      'observation_reflection',
      'policy_feedback_backprop',
    ];
    for (const mod of expectedModules) {
      assert.ok(result.stdout.includes(mod), `help should mention ${mod}`);
    }
  });

  it('should output Generated at timestamp', async () => {
    const result = await runScript('scripts/memory-evolve.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.match(/Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/));
  });

  it('should be report-only (no write operations)', async () => {
    const result = await runScript('scripts/memory-evolve.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('sample report'));
    assert.ok(!result.stdout.toLowerCase().includes('writing to') && !result.stdout.toLowerCase().includes('applied'));
  });

  it('should produce valid JSON with --json', async () => {
    const result = await runScript('scripts/memory-evolve.ts', ['--json']);
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.mode, 'dry_run');
    assert.strictEqual(parsed.report_only, true);
    assert.ok(Array.isArray(parsed.blockers));
    assert.strictEqual(typeof parsed.summary, 'object');
    assert.strictEqual(typeof parsed.sections, 'object');
    assert.ok(Object.keys(parsed.sections).length >= 8);
  });
});
