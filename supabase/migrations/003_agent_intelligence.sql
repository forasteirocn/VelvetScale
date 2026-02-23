-- ============================================
-- VelvetScale — Agent Intelligence Tables
-- ============================================

-- Track comment interactions (replies to comments on model's posts)
CREATE TABLE IF NOT EXISTS comment_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id),
    post_url TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    comment_author TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    replied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comment_interactions_model ON comment_interactions(model_id);
CREATE INDEX idx_comment_interactions_post ON comment_interactions(post_url);

-- Track karma-building actions (comments on other posts)
CREATE TABLE IF NOT EXISTS karma_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id),
    subreddit TEXT NOT NULL,
    post_url TEXT NOT NULL,
    post_title TEXT,
    comment_text TEXT NOT NULL,
    upvotes_received INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_karma_actions_model ON karma_actions(model_id);
CREATE INDEX idx_karma_actions_date ON karma_actions(created_at);

-- Track sub performance metrics (aggregated from posts)
CREATE TABLE IF NOT EXISTS sub_performance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id),
    subreddit TEXT NOT NULL,
    total_posts INTEGER DEFAULT 0,
    total_upvotes INTEGER DEFAULT 0,
    total_comments INTEGER DEFAULT 0,
    avg_upvotes REAL DEFAULT 0,
    posts_removed INTEGER DEFAULT 0,
    best_posting_hour INTEGER, -- 0-23 UTC
    last_calculated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(model_id, subreddit)
);

CREATE INDEX idx_sub_performance_model ON sub_performance(model_id);

-- Add engagement_score and is_banned to subreddits
ALTER TABLE subreddits ADD COLUMN IF NOT EXISTS engagement_score REAL DEFAULT 0;
ALTER TABLE subreddits ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE subreddits ADD COLUMN IF NOT EXISTS member_count INTEGER DEFAULT 0;
ALTER TABLE subreddits ADD COLUMN IF NOT EXISTS rules_summary TEXT;
ALTER TABLE subreddits ADD COLUMN IF NOT EXISTS suggested_by_ai BOOLEAN DEFAULT false;

-- Add upvotes/comments tracking to posts
ALTER TABLE posts ADD COLUMN IF NOT EXISTS upvotes INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comments_count INTEGER DEFAULT 0;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
