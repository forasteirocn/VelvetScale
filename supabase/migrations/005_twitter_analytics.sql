-- 005: Twitter Analytics table for Learning Engine
-- Tracks tweet performance metrics over time

CREATE TABLE IF NOT EXISTS twitter_analytics (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    model_id UUID REFERENCES models(id) ON DELETE CASCADE NOT NULL,
    tweet_id TEXT NOT NULL,
    tweet_url TEXT,
    tweet_text TEXT,
    content_type TEXT DEFAULT 'reddit_repurpose', -- reddit_repurpose, original, poll, question, thread, trend
    hashtags TEXT[],
    impressions INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    retweets INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    quotes INTEGER DEFAULT 0,
    bookmarks INTEGER DEFAULT 0,
    snapshot_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_twitter_analytics_model ON twitter_analytics(model_id);
CREATE INDEX idx_twitter_analytics_tweet ON twitter_analytics(tweet_id);
CREATE UNIQUE INDEX idx_twitter_analytics_unique ON twitter_analytics(model_id, tweet_id);
