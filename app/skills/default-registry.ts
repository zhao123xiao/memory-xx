import { SkillRegistry } from "./skill-registry";
import {
  DEEP_SEARCH_SKILL,
  SMART_WRITE_SKILL,
  HEALTH_CHECK_SKILL,
  MEMORY_CLEANUP_SKILL,
  createDeepSearchExecutor,
  createSmartWriteExecutor,
  createHealthCheckExecutor,
  createMemoryCleanupExecutor,
} from "./builtins";

export interface DefaultSkillRegistryDeps {
  readonly baseUrl: string;
  readonly apiToken?: string;
}

export function createDefaultSkillRegistry(deps: DefaultSkillRegistryDeps): SkillRegistry {
  const registry = new SkillRegistry();

  registry.register(DEEP_SEARCH_SKILL, createDeepSearchExecutor(deps));
  registry.register(SMART_WRITE_SKILL, createSmartWriteExecutor(deps));
  registry.register(HEALTH_CHECK_SKILL, createHealthCheckExecutor(deps));
  registry.register(MEMORY_CLEANUP_SKILL, createMemoryCleanupExecutor(deps));

  return registry;
}
