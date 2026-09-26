-- Preserve existing records while adding optimistic concurrency control.
ALTER TABLE attendance ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
