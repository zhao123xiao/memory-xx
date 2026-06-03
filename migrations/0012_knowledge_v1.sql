-- Migration 0012: knowledge-v1 metadata tables.
-- Knowledge chunks share the same Postgres/Qdrant infrastructure as memory-xx,
-- but stay in a separate schema and Qdrant collection.

CREATE SCHEMA IF NOT EXISTS knowledge_v1;

CREATE TABLE IF NOT EXISTS knowledge_v1.documents (
  id text PRIMARY KEY,
  collection text NOT NULL,
  repo text NOT NULL,
  source_root text,
  source_path text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection, source_path)
);

CREATE TABLE IF NOT EXISTS knowledge_v1.chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES knowledge_v1.documents(id) ON DELETE CASCADE,
  collection text NOT NULL,
  repo text NOT NULL,
  source_path text NOT NULL,
  chunk_index integer,
  start_line integer,
  end_line integer,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding_model text,
  embedding_dimension integer NOT NULL DEFAULT 4096,
  qdrant_point_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_collection
  ON knowledge_v1.chunks (collection);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_repo_path
  ON knowledge_v1.chunks (repo, source_path);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON knowledge_v1.chunks (document_id, chunk_index);
