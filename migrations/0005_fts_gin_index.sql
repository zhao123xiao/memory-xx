-- Migration 0005: Add tsvector column + GIN index for full-text search.
-- Uses a trigger to maintain the tsvector column on INSERT/UPDATE.
-- Covers: title (A weight), content (A), summary (B), source paths (C), tags (C), entity_names (C).
-- Generated columns cannot reference other tables, so we use a trigger-based approach.

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS fts_document tsvector;

-- Function to build the tsvector from record fields + pluggable metadata.
-- Sources from memory_sources are NOT included in the trigger (cross-table)
-- but title + content + summary + tags + entity_names cover the critical paths.
CREATE OR REPLACE FUNCTION memory_records_fts_trigger()
RETURNS trigger AS $$
DECLARE
  tag_text text := '';
  entity_text text := '';
BEGIN
  -- Extract tags from metadata JSON
  IF NEW.metadata ? 'tags' AND jsonb_typeof(NEW.metadata->'tags') = 'array' THEN
    SELECT string_agg(t, ' ') INTO tag_text
    FROM jsonb_array_elements_text(NEW.metadata->'tags') t;
  END IF;

  -- Extract entity_names from metadata JSON
  IF NEW.metadata ? 'entity_names' AND jsonb_typeof(NEW.metadata->'entity_names') = 'array' THEN
    SELECT string_agg(t, ' ') INTO entity_text
    FROM jsonb_array_elements_text(NEW.metadata->'entity_names') t;
  END IF;

  NEW.fts_document :=
    setweight(to_tsvector('simple', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.content, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(tag_text, '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(entity_text, '')), 'C');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memory_records_fts
  BEFORE INSERT OR UPDATE OF title, content, summary, metadata ON memory_records
  FOR EACH ROW
  EXECUTE FUNCTION memory_records_fts_trigger();

-- Backfill existing rows
UPDATE memory_records SET fts_document = fts_document WHERE fts_document IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_records_fts_document_gin
  ON memory_records
  USING gin (fts_document)
  WHERE fts_document IS NOT NULL;
