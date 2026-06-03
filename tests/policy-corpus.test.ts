import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHardNegativeSamples,
  buildLocalNegativeSamples,
  buildPolicyCompareObservations,
  buildPolicyTrainingReport,
  buildPolicyTrainingRecommendations,
  evaluatePolicyCorpus,
  evaluatePolicyCorpusUpdateFlow,
  extractBenchmarkRecords,
  isSafePolicyCorpusZipEntry,
  normalizeBenchmarkRecord,
  padPolicyCorpusSamples,
  validatePolicyEvalScope,
} from "../app/governance/policy-corpus";

test("policy corpus normalization handles LoCoMo, LongMemEval, and BEAM shaped records", () => {
  const locomo = normalizeBenchmarkRecord("locomo", {
    sample_id: "locomo-1",
    conversation: [
      { speaker: "user", text: "I prefer concise Chinese answers." },
      { speaker: "assistant", text: "Noted." },
    ],
    question: "What answer style does the user prefer?",
    answer: "concise Chinese answers",
  });
  const longmem = normalizeBenchmarkRecord("longmemeval", {
    id: "long-1",
    haystack_sessions: [["user: My default model is dreamfield/DeepSeek-V4-Flash."]],
    question: "What is the default model?",
    answer: "dreamfield/DeepSeek-V4-Flash",
    category: "information_extraction",
  });
  const beam = normalizeBenchmarkRecord("beam", {
    uuid: "beam-1",
    memory: "The user's timezone changed from UTC to Asia/Shanghai.",
    prompt: "Which timezone should be used now?",
    target: "Asia/Shanghai",
    ability: "knowledge_update",
  });

  assert.equal(locomo.dataset, "locomo");
  assert.equal(locomo.expected_memory_class, "preference");
  assert.equal(locomo.expected_policy_action, "create_memory");
  assert.equal(longmem.expected_memory_class, "long_term_fact");
  assert.equal(longmem.expected_recall_policy, "default");
  assert.equal(beam.expected_update_action, "supersede");
  assert.equal(beam.risk_tags.includes("preference_update"), true);
});

test("policy corpus extracts benchmark rows from nested repository shaped containers", () => {
  const rows = extractBenchmarkRecords({
    locomo: {
      train: [
        { id: "locomo-train-1", context: "User prefers short answers." },
      ],
    },
    longmemeval: {
      data: [
        { id: "long-1", question: "Which model?", answer: "DeepSeek" },
      ],
    },
    beam: {
      examples: [
        { uuid: "beam-1", memory: "The endpoint changed from /old to /new.", ability: "knowledge_update" },
      ],
    },
  });

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.dataset), ["locomo", "longmemeval", "beam"]);
  assert.deepEqual(rows.map((row) => row.raw && typeof row.raw === "object" ? (row.raw as { id?: string; uuid?: string }).id ?? (row.raw as { uuid?: string }).uuid : ""), [
    "locomo-train-1",
    "long-1",
    "beam-1",
  ]);
});

test("policy corpus extracts memory-benchmark result evaluation rows", () => {
  const rows = extractBenchmarkRecords({
    metadata: { project_name: "platform-locomo" },
    evaluations: [
      {
        question_id: "conv0_q0",
        category_name: "temporal",
        question: "When did Caroline go to the support group?",
        ground_truth_answer: "7 May 2023",
        cutoff_results: {
          top_200: {
            judgment: "CORRECT",
            generated_answer: "May 7, 2023",
          },
        },
      },
    ],
  }, "locomo_results");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset, "locomo");
  assert.equal((rows[0].raw as { source?: string }).source, "mem0ai/memory-benchmarks-results");
  assert.equal((rows[0].raw as { answer?: string }).answer, "7 May 2023");
  assert.equal((rows[0].raw as { generated_answer?: string }).generated_answer, "May 7, 2023");
});

test("policy corpus normalization maps result row types to policy labels", () => {
  const locomo = normalizeBenchmarkRecord("locomo", {
    question_id: "locomo-temporal",
    category_name: "temporal",
    question: "When did Caroline go to the support group?",
    ground_truth_answer: "7 May 2023",
    source: "mem0ai/memory-benchmarks-results",
  });
  const longmemUpdate = normalizeBenchmarkRecord("longmemeval", {
    question_id: "long-update",
    question_type: "knowledge-update",
    question: "Which timezone should be used now?",
    ground_truth_answer: "Asia/Shanghai",
    source: "mem0ai/memory-benchmarks-results",
  });
  const beamAbstention = normalizeBenchmarkRecord("beam", {
    question_id: "beam-abstain",
    question_type: "abstention",
    question: "Where did I study psychology?",
    ground_truth_answer: "Based on the provided chat, there is no information.",
    cutoff_results: { top_200: { generated_answer: "I don't have enough information." } },
    source: "mem0ai/memory-benchmarks-results",
  });

  assert.equal(locomo.risk_tags.includes("temporal"), true);
  assert.equal(locomo.source, "mem0ai/memory-benchmarks-results");
  assert.equal(longmemUpdate.expected_update_action, "supersede");
  assert.equal(longmemUpdate.risk_tags.includes("preference_update"), true);
  assert.equal(beamAbstention.expected_answerable, false);
  assert.equal(beamAbstention.expected_policy_action, "reject_by_policy");
  assert.equal(beamAbstention.expected_recall_policy, "never");
  assert.equal(beamAbstention.risk_tags.includes("abstention"), true);

  const coworker = normalizeBenchmarkRecord("longmemeval", {
    question_id: "long-coworker",
    question_type: "multi-session",
    question: "How much did I spend on each coffee mug for my coworkers?",
    ground_truth_answer: "$12",
    source: "mem0ai/memory-benchmarks-results",
  });
  assert.equal(coworker.expected_policy_action, "create_memory");
  assert.equal(coworker.risk_tags.includes("test_noise"), false);
});

test("policy corpus includes local pollution negatives for approval hardening", () => {
  const samples = buildLocalNegativeSamples("run-1");
  const byTag = new Set(samples.flatMap((sample) => sample.risk_tags));

  assert.equal(byTag.has("unknown_source"), true);
  assert.equal(byTag.has("config_dump"), true);
  assert.equal(byTag.has("test_noise"), true);
  assert.equal(byTag.has("no_memory"), true);
  assert.equal(byTag.has("operational_issue"), true);
});

test("policy corpus hard-negative padding reaches 10k without production scopes", () => {
  const base = [
    normalizeBenchmarkRecord("longmemeval", {
      id: "positive-1",
      context: "User uses model dreamfield/DeepSeek-V4-Flash.",
      question: "Which model?",
      answer: "dreamfield/DeepSeek-V4-Flash",
    }),
  ];

  const negatives = buildHardNegativeSamples("run-10k", 20);
  const padded = padPolicyCorpusSamples(base, "run-10k", 10000);

  assert.equal(negatives.length, 20);
  assert.equal(padded.length, 10000);
  assert.equal(padded.every((sample) => sample.scope_profile === "project" || sample.scope_profile === "user" || sample.scope_profile === "global"), true);
  assert.equal(padded.some((sample) => sample.risk_tags.includes("config_dump")), true);
  assert.equal(padded.some((sample) => sample.risk_tags.includes("unknown_source")), true);
  assert.equal(padded.some((sample) => sample.risk_tags.includes("no_memory")), true);
});

test("policy corpus offline eval reports precision, leakage, readiness, and progress", () => {
  const samples = [
    normalizeBenchmarkRecord("longmemeval", {
      id: "positive-1",
      context: "User uses model dreamfield/DeepSeek-V4-Flash.",
      question: "Which model?",
      answer: "dreamfield/DeepSeek-V4-Flash",
    }),
    ...buildLocalNegativeSamples("run-1"),
  ];

  const result = evaluatePolicyCorpus(samples);

  assert.equal(result.total, samples.length);
  assert.equal(result.progress_percent, 60);
  assert.equal(result.leakage_eval.test_noise_default_recall_leakage, 0);
  assert.equal(result.leakage_eval.explicit_only_default_recall_leakage, 0);
  assert.equal(result.metrics.reject_unknown_source_precision, 1);
  assert.equal(result.metrics.explicit_no_memory_reject_rate, 1);
  assert.ok(result.production_readiness_score >= 0);
});

test("policy corpus compare observations carry training source and clean pass signal", () => {
  const samples = [
    normalizeBenchmarkRecord("longmemeval", {
      id: "positive-1",
      context: "User uses model dreamfield/DeepSeek-V4-Flash.",
      question: "Which model?",
      answer: "dreamfield/DeepSeek-V4-Flash",
    }),
    ...buildLocalNegativeSamples("compare-run"),
  ];

  const observations = buildPolicyCompareObservations(samples, {
    runId: "memory-benchmark-10k-v1",
    sampleSize: 3,
    observedAt: "2026-05-31T12:00:00.000Z",
  });

  assert.equal(observations.length, 3);
  assert.equal(observations.every((item) => item.memoryCountDiff === 0), true);
  assert.equal(observations.every((item) => item.confidenceDiff === 0), true);
  assert.equal(observations.every((item) => item.metadata.source === "policy_training_compare_observation"), true);
  assert.equal(observations.every((item) => item.metadata.run_id === "memory-benchmark-10k-v1"), true);
  assert.equal(typeof observations[0].metadata.sample_id, "string");
});

test("policy corpus compare observations mark label mismatches as high-diff evidence", () => {
  const sample = normalizeBenchmarkRecord("longmemeval", {
    id: "positive-1",
    context: "User uses model dreamfield/DeepSeek-V4-Flash.",
    question: "Which model?",
    answer: "dreamfield/DeepSeek-V4-Flash",
  });
  const mismatched = {
    ...sample,
    expected_policy_action: "reject_by_policy" as const,
    expected_recall_policy: "never" as const,
  };

  const [observation] = buildPolicyCompareObservations([mismatched], {
    runId: "memory-benchmark-10k-v1",
    sampleSize: 1,
    observedAt: "2026-05-31T12:00:00.000Z",
  });

  assert.equal(observation.memoryCountDiff, 1);
  assert.equal(observation.confidenceDiff, 1);
  assert.equal(observation.metadata.passed, false);
  assert.notEqual(observation.metadata.actual_policy_action, "reject_by_policy");
});

test("policy corpus update flow evaluates supersede resolve reject and quarantine samples", () => {
  const samples = [
    normalizeBenchmarkRecord("beam", {
      id: "supersede-1",
      memory: "The user's timezone changed from UTC to Asia/Shanghai.",
      ability: "knowledge_update",
      answer: "Asia/Shanghai",
    }),
    normalizeBenchmarkRecord("local-negative", {
      id: "resolve-1",
      context: "模型连接失败的问题已解决 resolved。",
      source: "conversation_ingest",
    }),
    ...buildLocalNegativeSamples("update-flow"),
  ];

  const result = evaluatePolicyCorpusUpdateFlow(samples);

  assert.equal(result.checked >= 4, true);
  assert.equal(result.supersede_expected, 1);
  assert.equal(result.resolve_expected, 1);
  assert.equal(result.reject_expected >= 3, true);
  assert.equal(result.quarantine_expected, 1);
  assert.equal(result.knowledge_update_accuracy, 1);
});

test("policy corpus test scope guard rejects production scopes", () => {
  assert.equal(validatePolicyEvalScope("project", "memory-policy-eval-run-1").ok, true);
  assert.equal(validatePolicyEvalScope("user", "memory-policy-eval-run-1").ok, true);
  assert.equal(validatePolicyEvalScope("global", "memory-policy-eval-run-1").ok, true);

  assert.equal(validatePolicyEvalScope("project", "memory-xx").ok, false);
  assert.equal(validatePolicyEvalScope("user", "current-user").ok, false);
  assert.equal(validatePolicyEvalScope("global", "global").ok, false);
});

test("policy corpus training report computes staged percent from available artifacts", () => {
  const recommendations = buildPolicyTrainingRecommendations({
    metrics: {
      approve_default_precision: 0.94,
      reject_sensitive_precision: 1,
      reject_unknown_source_precision: 1,
      explicit_no_memory_reject_rate: 1,
      operational_issue_recall: 0.88,
      knowledge_update_accuracy: 0.89,
      abstention_accuracy: 0.9,
      global_scope_false_approve: 0,
    },
    leakage_eval: {
      test_noise_default_recall_leakage: 0,
      explicit_only_default_recall_leakage: 0,
    },
  });
  const report = buildPolicyTrainingReport({
    runId: "run-1",
    importedCount: 10000,
    normalizedCount: 10000,
    uniqueQuestionCount: 9380,
    offlineEval: { total: 10000, production_readiness_score: 0.91 },
    testScopeWrite: { written: 10000, rejected: 0, scopes: ["project:memory-policy-eval-run-1"] },
    recallEval: { checked: 1000, default_leakage: 0 },
    updateEval: { checked: 2500, knowledge_update_accuracy: 0.89 },
    recommendedPolicyChanges: recommendations,
  });

  assert.equal(report.progress_percent, 90);
  assert.equal(report.dataset_counts.normalized, 10000);
  assert.equal(report.dataset_counts.unique_questions, 9380);
  assert.equal(report.production_readiness_score, 0.91);
  assert.equal(report.update_eval.knowledge_update_accuracy, 0.89);
  assert.equal(report.recommended_policy_changes.includes("tighten_default_approval_precision"), true);
  assert.equal(report.recommended_policy_changes.includes("improve_operational_issue_classification"), true);
});

test("policy corpus training report reaches 90 when 10k closed loop has no recommendations", () => {
  const report = buildPolicyTrainingReport({
    runId: "run-perfect",
    importedCount: 9380,
    normalizedCount: 10000,
    uniqueQuestionCount: 9380,
    offlineEval: { total: 10000, production_readiness_score: 1 },
    testScopeWrite: { written: 10000, rejected: 4632, scopes: ["project:memory-policy-eval-run-perfect"] },
    recallEval: { checked: 10000, default_leakage: 0 },
    updateEval: { checked: 5164, knowledge_update_accuracy: 1 },
    recommendedPolicyChanges: [],
  });

  assert.equal(report.progress_percent, 90);
  assert.deepEqual(report.recommended_policy_changes, []);
});

test("policy corpus zip entry safety rejects path traversal and absolute paths", () => {
  assert.equal(isSafePolicyCorpusZipEntry("memory-benchmarks-main/results/platform/locomo_results.json"), true);
  assert.equal(isSafePolicyCorpusZipEntry("memory-benchmarks-main/"), true);
  assert.equal(isSafePolicyCorpusZipEntry("../outside.json"), false);
  assert.equal(isSafePolicyCorpusZipEntry("memory-benchmarks-main/../../outside.json"), false);
  assert.equal(isSafePolicyCorpusZipEntry("/tmp/outside.json"), false);
  assert.equal(isSafePolicyCorpusZipEntry("<windows-drive>\\\\tmp\\\\outside.json"), false);
});
