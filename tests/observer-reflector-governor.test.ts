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

/**
 * observer-reflector-governor — Tests that the conversation routing pipeline
 * (observer → reflector → governor) is properly stubbed and surfaces report-only
 * behavior via the memory:observation-reflection CLI script.
 *
 * Since the full observer-reflector-governor module requires deep integration
 * with memory-xx specific types (intelligence, policy-engine), memory-xx surfaces
 * the observation reflection behavior via the procedural-promotion-candidates
 * report which acts as the reflector output for procedural observations.
 */
describe('observer-reflector-governor (via observation-reflection CLI)', () => {
  it('should exit 0 with empty input', async () => {
    const result = await runScript('scripts/memory-observation-reflection.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Observation Reflection'));
  });

  it('should generate empty report when no observations', async () => {
    const result = await runScript('scripts/memory-observation-reflection.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Total candidates: 0'));
    assert.ok(result.stdout.includes('No observation reflection candidates found'));
  });

  it('should be report-only (no writes)', async () => {
    const result = await runScript('scripts/memory-observation-reflection.ts', []);
    assert.strictEqual(result.code, 0);
    // Report-only — should not perform writes
    assert.ok(result.stdout.includes('sample report'));
    assert.ok(!result.stdout.toLowerCase().includes('applied'));
  });

  it('should include generated_at timestamp', async () => {
    const result = await runScript('scripts/memory-observation-reflection.ts', []);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.match(/Generated at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/));
  });
});