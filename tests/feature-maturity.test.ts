import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const FEATURE_MATURITY_PATH = path.join(process.cwd(), 'configs/feature-maturity.json');

describe('feature-maturity.json', () => {
  it('should exist', () => {
    assert.ok(fs.existsSync(FEATURE_MATURITY_PATH), 'feature-maturity.json must exist');
  });

  it('should have valid structure', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      $schema?: string;
      description?: string;
      version?: string;
      features?: unknown[];
      maturity_levels?: Record<string, unknown>;
    };

    assert.ok(config.$schema, 'should have $schema');
    assert.ok(config.description, 'should have description');
    assert.ok(config.version, 'should have version');
    assert.ok(config.features, 'should have features array');
    assert.ok(Array.isArray(config.features), 'features should be an array');
    assert.ok(config.maturity_levels, 'should have maturity_levels');
  });

  it('should have valid maturity levels', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{
        id: string;
        name: string;
        maturity: string;
        surface: string;
        risk: string;
      }>;
    };

    const validMaturities = ['stable', 'beta', 'experimental', 'dangerous'];
    const validSurfaces = ['api', 'cli', 'mcp', 'internal'];

    for (const feature of config.features) {
      assert.ok(feature.id, `feature should have id`);
      assert.ok(feature.name, `feature ${feature.id} should have name`);
      assert.ok(validMaturities.includes(feature.maturity),
        `feature ${feature.id} has invalid maturity: ${feature.maturity}`);
      assert.ok(feature.surface, `feature ${feature.id} should have surface`);
      assert.ok(validSurfaces.includes(feature.surface),
        `feature ${feature.id} has invalid surface: ${feature.surface}`);
      assert.ok(feature.risk, `feature ${feature.id} should have risk`);
    }
  });

  it('should have valid maturity_levels definitions', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      maturity_levels: Record<string, {
        description?: string;
        default_state?: string;
      }>;
    };

    const validMaturities = ['stable', 'beta', 'experimental', 'dangerous'];

    for (const maturity of validMaturities) {
      assert.ok(config.maturity_levels[maturity],
        `maturity_levels should define ${maturity}`);
      assert.ok(config.maturity_levels[maturity].description,
        `${maturity} should have description`);
      assert.ok(config.maturity_levels[maturity].default_state,
        `${maturity} should have default_state`);
    }
  });

  it('dangerous features should have requires_apply or public_warning', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{
        id: string;
        maturity: string;
        requires_apply?: boolean;
        public_warning?: string;
      }>;
    };

    const dangerousFeatures = config.features.filter(f => f.maturity === 'dangerous');

    for (const feature of dangerousFeatures) {
      assert.ok(
        feature.requires_apply === true || feature.public_warning,
        `dangerous feature ${feature.id} should have requires_apply=true or public_warning`
      );
    }
  });

  it('dangerous features should be disabled, explicit-apply, and publicly warned', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{
        id: string;
        maturity: string;
        default_mode?: string;
        requires_apply?: boolean;
        public_warning?: string;
      }>;
    };

    const dangerousFeatures = config.features.filter(f => f.maturity === 'dangerous');

    for (const feature of dangerousFeatures) {
      assert.strictEqual(feature.default_mode, 'disabled',
        `dangerous feature ${feature.id} should be disabled by default`);
      assert.strictEqual(feature.requires_apply, true,
        `dangerous feature ${feature.id} should require explicit apply`);
      assert.ok(feature.public_warning && feature.public_warning.trim().length > 0,
        `dangerous feature ${feature.id} should have a public warning`);
    }
  });

  it('should categorize core features as stable', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{ id: string; maturity: string }>;
    };

    const coreFeatures = ['memory:write', 'memory:recall', 'memory:review',
      'memory:approve', 'memory:reject', 'memory:status', 'memory:doctor'];

    for (const id of coreFeatures) {
      const feature = config.features.find(f => f.id === id);
      if (feature) {
        assert.strictEqual(feature.maturity, 'stable',
          `core feature ${id} should be stable`);
      }
    }
  });

  it('should not have features without evidence', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{
        id: string;
        evidence?: string;
      }>;
    };

    for (const feature of config.features) {
      assert.ok(feature.evidence,
        `feature ${feature.id} should have evidence`);
    }
  });

  it('should match package.json scripts for unavailable features', () => {
    const content = fs.readFileSync(FEATURE_MATURITY_PATH, 'utf-8');
    const config = JSON.parse(content) as {
      features: Array<{
        id: string;
        status?: string;
      }>;
    };

    const packageJsonPath = path.join(process.cwd(), 'package.json');
    assert.ok(fs.existsSync(packageJsonPath), 'package.json should exist');

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const scripts = Object.keys(packageJson.scripts || {});

    // Features marked as unavailable MUST have placeholder scripts
    const unavailable = config.features.filter(f => f.status === 'unavailable');

    const missingScripts: string[] = [];
    for (const feature of unavailable) {
      const scriptName = feature.id.replace(/^(memory|mcp|test):/, 'memory:');
      if (!scripts.includes(scriptName)) {
        missingScripts.push(feature.id);
      }
    }

    assert.strictEqual(
      missingScripts.length,
      0,
      `Unavailable features must have placeholder scripts: ${missingScripts.join(', ')}`
    );
  });
});
