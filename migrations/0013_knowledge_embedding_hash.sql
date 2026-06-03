-- Migration 0013: knowledge chunk embedding integrity metadata.

ALTER TABLE knowledge_v1.chunks
  ADD COLUMN IF NOT EXISTS embedding_hash text,
  ADD COLUMN IF NOT EXISTS content_hash text;

UPDATE knowledge_v1.chunks
SET content_hash = md5(content)
WHERE content_hash IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hash
  ON knowledge_v1.chunks (embedding_hash)
  WHERE embedding_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_content_hash
  ON knowledge_v1.chunks (content_hash);
