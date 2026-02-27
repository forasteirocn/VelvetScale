import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { getTwitterClient, postTweet, hasWriteBudget } from './integrations/twitter';
import { generateSmartHashtags } from './twitter-hashtags';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Twitter Trend Rider
// Searches trending niche content → creates relevant posts
// Policy-compliant: only posts own content inspired by trends
// Runs every 8 hours
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let trendInterval: ReturnType<typeof setInterval> | null = null;

export function startTrendRider(): void {
    if (trendInterval) return;

    console.log('🔥 Twitter Trend Rider iniciado (8h intervals)');

    setTimeout(() => {
        rideTrends();
        trendInterval = setInterval(rideTrends, 8 * 60 * 60 * 1000); // 8h
    }, 60 * 60 * 1000); // First run after 1h
}

export function stopTrendRider(): void {
    if (trendInterval) {
        clearInterval(trendInterval);
        trendInterval = null;
    }
}

async function rideTrends(): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona, twitter_handle, twitter_access_token, enabled_platforms')
        .eq('status', 'active')
        .not('twitter_access_token', 'is', null);

    if (!models?.length) return;

    for (const model of models) {
        if (!isPlatformEnabled(model, 'twitter')) continue;
        try {
            if (!await hasWriteBudget(model.id, 1)) continue;

            await rideForModel(model);
        } catch (err) {
            console.error(`❌ Trend Rider error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

// Niche search queries to rotate through
const NICHE_QUERIES = [
    'selfie model',
    'content creator tips',
    'gym selfie',
    'new photos',
    'glow up',
    'photoshoot',
    'confidence',
    'fitness model',
];

async function rideForModel(model: {
    id: string;
    phone: string;
    persona: string;
    bio: string;
    twitter_handle: string;
}): Promise<void> {
    const auth = await getTwitterClient(model.id);
    if (!auth) return;

    const { client } = auth;
    const supabase = getSupabaseAdmin();

    // Pick a random niche query
    const query = NICHE_QUERIES[Math.floor(Math.random() * NICHE_QUERIES.length)];

    try {
        // Search recent popular tweets in niche
        const searchResult = await client.v2.search(query, {
            max_results: 10,
            'tweet.fields': ['public_metrics', 'text', 'created_at'],
            sort_order: 'relevancy',
        });

        if (!searchResult.data?.data?.length) {
            console.log(`  🔥 No trend results for "${query}"`);
            return;
        }

        // Filter for tweets with decent engagement
        const popular = searchResult.data.data.filter(t => {
            const m = t.public_metrics;
            return m && (m.like_count || 0) > 5;
        });

        if (popular.length === 0) return;

        // Build context of what's trending
        const trendContext = popular
            .slice(0, 5)
            .map(t => `- "${t.text.substring(0, 100)}" (${t.public_metrics?.like_count || 0} likes)`)
            .join('\n');

        // Generate our own take on the trend
        const tweet = await generateTrendTweet(
            query,
            trendContext,
            model.persona,
            model.bio
        );

        if (!tweet) return;

        // Add hashtags
        const hashtags = await generateSmartHashtags(model.persona, model.bio, query);
        const fullTweet = hashtags
            ? `${tweet}\n\n${hashtags}`.substring(0, 280)
            : tweet;

        // Post it
        const result = await postTweet(model.id, fullTweet);

        if (result.success) {
            await supabase.from('posts').insert({
                model_id: model.id,
                platform: 'twitter',
                post_type: 'tweet',
                title: fullTweet,
                content: fullTweet,
                media_urls: [],
                external_url: result.url,
                status: 'published',
                published_at: new Date().toISOString(),
            });

            await supabase.from('agent_logs').insert({
                model_id: model.id,
                action: 'twitter_trend_post',
                platform: 'twitter',
                details: {
                    content_type: 'trend',
                    trend_query: query,
                    tweet_url: result.url,
                    tweet_text: fullTweet.substring(0, 100),
                },
            });

            console.log(`  🔥 Trend post (${query}): "${fullTweet.substring(0, 50)}..."`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429')) {
            console.log(`  ⚠️ Search rate limited, will retry next cycle`);
        } else {
            console.error(`  ❌ Trend search error:`, msg);
        }
    }
}

async function generateTrendTweet(
    topic: string,
    trendContext: string,
    persona: string,
    bio: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            system: `You are a content creator jumping on a trending topic on Twitter.
Persona: ${persona || 'flirty, confident, fun'}
Bio: ${bio || 'content creator'}

Rules:
- Create an ORIGINAL tweet inspired by the trending topic
- Max 200 characters (leave room for hashtags)
- Be relevant to the trend but make it YOUR take
- 1-2 emojis max
- Casual, lowercase is fine
- NO links, NO promotions, NO @mentions
- Make it engaging and shareable
- DO NOT copy any of the trending tweets — be original

Output ONLY the tweet text.`,
            messages: [{
                role: 'user',
                content: `Trending topic: "${topic}"\n\nPopular tweets right now:\n${trendContext}\n\nCreate your own take:`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        if (!text || text.length > 250) return null;

        const refusals = ['i can\'t', 'i cannot', 'as an ai', 'i apologize'];
        if (refusals.some(r => text.toLowerCase().includes(r))) return null;

        return text;
    } catch {
        return null;
    }
}
