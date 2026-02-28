-- ============================================
-- VelvetScale — Add needs_verification column
-- Blocks posting to subs that require prior verification
-- ============================================

-- Add needs_verification flag (default false)
ALTER TABLE subreddits
ADD COLUMN IF NOT EXISTS needs_verification BOOLEAN DEFAULT false;

-- Mark known verification-requiring subs based on existing posting_rules
UPDATE subreddits
SET needs_verification = true
WHERE posting_rules->>'requires_verification' = 'true'
  AND (needs_verification IS NULL OR needs_verification = false);
