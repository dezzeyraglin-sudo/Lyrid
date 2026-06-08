-- ============================================================================
-- Drop #22 — June 7, 2026: Per-inning data capture
-- ============================================================================
-- Adds a JSONB column to projection_audit for storing per-inning runs/hits.
-- Shape per row:
--   [
--     {"num": 1, "awayRuns": 0, "homeRuns": 1, "awayHits": 1, "homeHits": 2},
--     {"num": 2, "awayRuns": 2, "homeRuns": 0, "awayHits": 2, "homeHits": 0},
--     ...
--   ]
--
-- Backward compatible: existing rows have innings=NULL, populated by:
--   1. New games as they grade (gradeProjectionAudit captures the linescore)
--   2. One-time backfill via the "⊕ BACKFILL INNINGS" button on History tab
-- ============================================================================

alter table public.projection_audit
  add column if not exists innings jsonb;

-- Useful for finding games where the backfill hasn't run yet
create index if not exists projection_audit_user_innings_null_idx
  on public.projection_audit(user_id)
  where innings is null;
