CREATE TABLE IF NOT EXISTS runtime_agent_connections (
  connection_id text PRIMARY KEY,
  agent_id text NOT NULL,
  identity_source text NOT NULL DEFAULT 'unknown-source',
  transport text NOT NULL DEFAULT 'unknown',
  endpoint text NOT NULL DEFAULT 'unknown-endpoint',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  methods text[] NOT NULL DEFAULT '{}'::text[],
  permissions text[] NOT NULL DEFAULT '{}'::text[],
  remote_address text,
  user_agent text,
  client_name text,
  last_status integer,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_agent_connections_last_seen
  ON runtime_agent_connections (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_agent_connections_agent
  ON runtime_agent_connections (agent_id, transport, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS runtime_tool_invocations (
  tool_name text PRIMARY KEY,
  call_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  latency_total_ms bigint NOT NULL DEFAULT 0,
  latency_max_ms integer NOT NULL DEFAULT 0,
  last_latency_ms integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  agents text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_tool_invocations_last_seen
  ON runtime_tool_invocations (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS runtime_component_snapshots (
  component_snapshot_id text PRIMARY KEY,
  snapshot_id text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  component_name text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  detail text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'runtime_snapshot',
  remediation text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_runtime_component_snapshots_component
  ON runtime_component_snapshots (component_name, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_component_snapshots_status
  ON runtime_component_snapshots (status, collected_at DESC);

CREATE TABLE IF NOT EXISTS runtime_setting_effective_values (
  setting_key text PRIMARY KEY,
  category text NOT NULL DEFAULT 'config',
  label text NOT NULL DEFAULT '',
  effective_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  default_value jsonb NOT NULL DEFAULT 'null'::jsonb,
  source text NOT NULL DEFAULT 'default',
  effect_status text NOT NULL DEFAULT 'read_only_env',
  safety text NOT NULL DEFAULT 'safe',
  service text,
  unit text,
  writable boolean NOT NULL DEFAULT false,
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_runtime_setting_effective_values_category
  ON runtime_setting_effective_values (category, setting_key);

CREATE INDEX IF NOT EXISTS idx_runtime_setting_effective_values_effect
  ON runtime_setting_effective_values (effect_status, safety);

CREATE TABLE IF NOT EXISTS code_graph_project_snapshots (
  snapshot_id text PRIMARY KEY,
  project_id text NOT NULL,
  root text NOT NULL,
  commit_hash text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  file_count integer NOT NULL DEFAULT 0,
  symbol_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  code_graph_scope text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run boolean NOT NULL DEFAULT true,
  writes_global boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_code_graph_project_snapshots_project
  ON code_graph_project_snapshots (project_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS ops_advisor_reports (
  report_id text PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  advisor_type text NOT NULL DEFAULT 'auto_approval',
  mode text NOT NULL DEFAULT 'report_only',
  status text NOT NULL DEFAULT 'reported',
  recommendation_count integer NOT NULL DEFAULT 0,
  high_risk_count integer NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ops_advisor_reports_generated
  ON ops_advisor_reports (advisor_type, generated_at DESC);
