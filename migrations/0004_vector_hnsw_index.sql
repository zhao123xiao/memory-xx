-- Migration 0004: Add HNSW index on content_embedding for fast approximate nearest-neighbor search.
-- pgvector HNSW has a 2000-dimension limit. The production Qwen3-Embedding-8B
-- path uses 4096 dimensions and relies on Qdrant as the primary vector index, so
-- pgvector fallback must skip HNSW instead of failing fresh migrations.

DO $$
DECLARE
  embedding_type text;
  embedding_dimensions integer;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO embedding_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND c.relname = 'memory_records'
     AND a.attname = 'content_embedding'
     AND NOT a.attisdropped;

  embedding_dimensions := NULLIF(regexp_replace(COALESCE(embedding_type, ''), '^vector\(([0-9]+)\)$', '\1'), COALESCE(embedding_type, ''))::integer;

  IF embedding_dimensions IS NULL THEN
    RAISE NOTICE 'Skipping HNSW index: memory_records.content_embedding type is %', embedding_type;
  ELSIF embedding_dimensions <= 2000 THEN
    CREATE INDEX IF NOT EXISTS idx_memory_records_content_embedding_hnsw
      ON memory_records
      USING hnsw (content_embedding vector_cosine_ops)
      WHERE content_embedding IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping HNSW index: vector dimension % exceeds pgvector HNSW limit 2000', embedding_dimensions;
  END IF;
END $$;
