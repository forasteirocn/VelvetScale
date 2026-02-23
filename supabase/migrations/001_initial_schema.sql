-- ============================================
-- VelvetScale — Database Schema
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. Models (content creators / clients)
-- ============================================
CREATE TABLE IF NOT EXISTS models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    onlyfans_url TEXT,
    privacy_url TEXT,
    bio TEXT,
    persona TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended')),
    plan TEXT NOT NULL DEFAULT 'basic'
        CHECK (plan IN ('basic', 'pro', 'enterprise')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 2. Social Accounts (Reddit / Twitter)
-- ============================================
CREATE TABLE IF NOT EXISTS social_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('reddit', 'twitter')),
    username TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(model_id, platform)
);

-- ============================================
-- 3. Posts / Actions
-- ============================================
CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    social_account_id UUID REFERENCES social_accounts(id) ON DELETE SET NULL,
    platform TEXT NOT NULL CHECK (platform IN ('reddit', 'twitter')),
    post_type TEXT NOT NULL DEFAULT 'post'
        CHECK (post_type IN ('post', 'tweet', 'comment', 'reply', 'thread')),
    content TEXT NOT NULL,
    media_urls TEXT[],
    external_id TEXT,
    external_url TEXT,
    subreddit TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'scheduled', 'published', 'failed', 'deleted')),
    scheduled_for TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    engagement JSONB DEFAULT '{}',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 4. WhatsApp Commands
-- ============================================
CREATE TABLE IF NOT EXISTS commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID REFERENCES models(id) ON DELETE SET NULL,
    raw_message TEXT NOT NULL,
    parsed_intent TEXT,
    parsed_params JSONB,
    status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'processing', 'completed', 'failed')),
    result_message TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- 5. Subreddits (discovered / approved)
-- ============================================
CREATE TABLE IF NOT EXISTS subreddits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT,
    nsfw BOOLEAN NOT NULL DEFAULT false,
    subscribers INTEGER DEFAULT 0,
    posting_rules JSONB,
    last_posted_at TIMESTAMPTZ,
    is_approved BOOLEAN NOT NULL DEFAULT false,
    cooldown_hours INTEGER DEFAULT 24,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(model_id, name)
);

-- ============================================
-- 6. Agent Logs
-- ============================================
CREATE TABLE IF NOT EXISTS agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    platform TEXT,
    details JSONB DEFAULT '{}',
    tokens_used INTEGER DEFAULT 0,
    cost_usd DECIMAL(10,4) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Indexes
-- ============================================
CREATE INDEX IF NOT EXISTS idx_social_accounts_model ON social_accounts(model_id);
CREATE INDEX IF NOT EXISTS idx_posts_model ON posts(model_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_commands_model ON commands(model_id);
CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
CREATE INDEX IF NOT EXISTS idx_subreddits_model ON subreddits(model_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_model ON agent_logs(model_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created ON agent_logs(created_at);

-- ============================================
-- Row Level Security
-- ============================================
ALTER TABLE models ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE subreddits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_logs ENABLE ROW LEVEL SECURITY;

-- Service role can access everything (for backend workers)
CREATE POLICY "service_role_all" ON models FOR ALL
    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON social_accounts FOR ALL
    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON posts FOR ALL
    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON commands FOR ALL
    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON subreddits FOR ALL
    USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON agent_logs FOR ALL
    USING (auth.role() = 'service_role');

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER models_updated_at
    BEFORE UPDATE ON models
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER social_accounts_updated_at
    BEFORE UPDATE ON social_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
