-- Context hierarchy: groups become deterministic retrieval buckets.
-- group_kind distinguishes profile/topic/project/etc.
-- retrieval_priority controls deterministic startup inclusion order.
-- canonical_item_id points to the single current canonical item for this group.

ALTER TABLE groups ADD COLUMN group_kind TEXT NOT NULL DEFAULT 'topic';
ALTER TABLE groups ADD COLUMN retrieval_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN canonical_item_id INTEGER REFERENCES todos(id) ON DELETE SET NULL;
ALTER TABLE groups ADD COLUMN summary_mode TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX IF NOT EXISTS idx_groups_kind ON groups(group_kind);
CREATE INDEX IF NOT EXISTS idx_groups_retrieval_priority ON groups(retrieval_priority DESC);
CREATE INDEX IF NOT EXISTS idx_groups_canonical_item ON groups(canonical_item_id);

-- Ensure the special profile group exists for deterministic profile retrieval.
INSERT OR IGNORE INTO groups (name, slug, group_kind, retrieval_priority, description)
VALUES ('Profile', 'profile', 'profile', 10, 'Canonical user profile context');
