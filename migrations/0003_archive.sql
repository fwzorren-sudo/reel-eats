-- Archiving hides a place everywhere but keeps it, so another reel of it isn't saved again.
-- It's separate from visit_status, so a visited place keeps its rating and notes.
ALTER TABLE places ADD COLUMN archived_at INTEGER;
ALTER TABLE places ADD COLUMN archive_reason TEXT;   -- not-for-me | closed | too-far | other, or NULL
