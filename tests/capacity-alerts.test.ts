import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenFeishuCard,
  buildRecoveredFeishuCard,
  shouldSendOpenAlert,
  type CapacityAuditCheck,
} from "../src/governance/capacity-audit";

const check: CapacityAuditCheck = {
  id: "pg_memory_records_rows",
  resource: "pg.memory_records",
  metric: "rows",
  value: 120000,
  threshold: 100000,
  unit: "rows",
  status: "warning",
  details: {},
};

test("Feishu open alert card uses interactive payload", () => {
  const payload = buildOpenFeishuCard(check, "warning");
  assert.equal(payload.msg_type, "interactive");
  assert.equal((payload.card as any).header.template, "red");
  assert.match((payload.card as any).elements[0].text.content, /pg\.memory_records/);
  assert.match((payload.card as any).elements[0].text.content, /warning/);
});

test("Feishu recovered card uses green template", () => {
  const payload = buildRecoveredFeishuCard({ resource: "pg.memory_records", metric: "rows", level: "warning" });
  assert.equal(payload.msg_type, "interactive");
  assert.equal((payload.card as any).header.template, "green");
});

test("alert send policy suppresses first warning and repeats after six hours", () => {
  assert.equal(shouldSendOpenAlert(null, "2026-05-20T10:00:00.000Z", "warning", 1, "https://example.test"), false);
  assert.equal(shouldSendOpenAlert(null, "2026-05-20T10:00:00.000Z", "warning", 2, "https://example.test"), true);
  assert.equal(shouldSendOpenAlert(null, "2026-05-20T10:00:00.000Z", "critical", 1, "https://example.test"), true);
  assert.equal(shouldSendOpenAlert("2026-05-20T09:00:00.000Z", "2026-05-20T10:00:00.000Z", "critical", 2, "https://example.test"), false);
  assert.equal(shouldSendOpenAlert("2026-05-20T03:00:00.000Z", "2026-05-20T10:00:00.000Z", "critical", 2, "https://example.test"), true);
  assert.equal(shouldSendOpenAlert(null, "2026-05-20T10:00:00.000Z", "critical", 1, ""), false);
});
