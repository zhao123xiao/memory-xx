CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS content_embedding vector(4096);
