-- Align memory_feedback_events with the typed snapshot model.

ALTER TABLE memory_feedback_events
  ADD COLUMN IF NOT EXISTS governance_triggered boolean NOT NULL DEFAULT false;

ALTER TABLE memory_feedback_events
  ADD COLUMN IF NOT EXISTS governance_action_id text;
