-- ============================================
-- VelvetScale — Platform Toggles per Model
-- Allows enabling/disabling Reddit and Twitter per model
-- ============================================

-- Add enabled_platforms column (default: reddit only)
ALTER TABLE models
ADD COLUMN IF NOT EXISTS enabled_platforms JSONB DEFAULT '{"reddit": true, "twitter": false}'::jsonb;

-- Set existing active models to have both enabled (since they're already using both)
UPDATE models
SET enabled_platforms = '{"reddit": true, "twitter": true}'::jsonb
WHERE status = 'active'
  AND enabled_platforms IS NULL;
