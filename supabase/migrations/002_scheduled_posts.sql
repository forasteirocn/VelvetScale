-- ============================================
-- VelvetScale — Scheduled Posts Table
-- ============================================

CREATE TABLE IF NOT EXISTS scheduled_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    photo_url TEXT NOT NULL,
    original_caption TEXT,
    improved_title TEXT,
    target_subreddit TEXT,
    scheduled_for TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'improving', 'ready', 'processing', 'published', 'failed')),
    result_url TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for scheduler lookups
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON scheduled_posts(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_model ON scheduled_posts(model_id);

-- RLS
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON scheduled_posts FOR ALL
    USING (auth.role() = 'service_role');
