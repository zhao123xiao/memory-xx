-- Migration 0010: retire the empty legacy public.memory_records table.
--
-- memory_xx.memory_records is the only production truth table. The old public
-- table is safe to rename only when it is empty; if it ever contains rows, stop
-- the migration so a human can inspect before any destructive action.

DO $$
DECLARE
  legacy_count bigint;
BEGIN
  IF to_regclass('public.memory_records') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.memory_records' INTO legacy_count;
  IF legacy_count <> 0 THEN
    RAISE EXCEPTION 'Refusing to retire public.memory_records because it contains % rows', legacy_count;
  END IF;

  IF to_regclass('public.memory_records_legacy_empty') IS NULL THEN
    ALTER TABLE public.memory_records RENAME TO memory_records_legacy_empty;
    COMMENT ON TABLE public.memory_records_legacy_empty IS
      'Retired empty legacy memory table. Production memory-xx truth table is memory_xx.memory_records.';
  ELSE
    DROP TABLE public.memory_records;
  END IF;
END $$;
