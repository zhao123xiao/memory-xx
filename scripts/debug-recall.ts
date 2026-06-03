import { createPostgresRecallRuntime, loadMemoryV2PostgresConfig, FilterMode, type RecallRequest, type PostgresRecallRuntime } from "../app";

async function main() {
  const config = loadMemoryV2PostgresConfig();
  const runtime: PostgresRecallRuntime = createPostgresRecallRuntime({ config });

  const request: RecallRequest = {
    query: "我的安全边界是什么",
    scope_context: {
      user_id: "current-instance-owner",
      workspace_id: "current-instance",
      project_ids: ["memory-system", "new-memory-architecture", "governance-round4a-bridge"],
      include_global: true
    },
    filter_mode: FilterMode.Default,
    explain: true,
    limit: 5
  };

  const response = await runtime.orchestrator.execute(request);
  console.log("Results:", response.results.length);
  console.log("Degraded:", response.degraded, response.degrade_reason);
  console.log("Audit:", JSON.stringify(response.audit, null, 2));
  for (const r of response.results) {
    console.log(`  - ${r.title}: ${r.content.slice(0, 80)}...`);
  }

  await runtime.close();
}

main().catch(console.error);
