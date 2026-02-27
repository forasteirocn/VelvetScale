import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { getTwitterClient } from './integrations/twitter';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Twitter Learning Engine
// Tracks tweet metrics → generates insights for Claude
// Runs daily
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let learningInterval: ReturnType<typeof setInterval> | null = null;

export function startTwitterLearning(): void {
    if (learningInterval) return;

    console.log('📈 Twitter Learning Engine iniciado (diário)');

    setTimeout(() => {
        updateTwitterMetrics();
        learningInterval = setInterval(updateTwitterMetrics, 24 * 60 * 60 * 1000); // Daily
    }, 45 * 60 * 1000); // First run after 45 min
}

export function stopTwitterLearning(): void {
    if (learningInterval) {
        clearInterval(learningInterval);
        learningInterval = null;
    }
}

async function updateTwitterMetrics(): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona, twitter_access_token, enabled_platforms')
        .eq('status', 'active')
        .not('twitter_access_token', 'is', null);

    if (!models?.length) return;

    for (const model of models) {
        if (!isPlatformEnabled(model, 'twitter')) continue;
        try {
            await trackMetricsForModel(model);
        } catch (err) {
            console.error(`❌ Twitter learning error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

async function trackMetricsForModel(model: {
    id: string;
    phone: string;
    persona: string;
    bio: string;
}): Promise<void> {
    const auth = await getTwitterClient(model.id);
    if (!auth) return;

    const { client } = auth;
    const supabase = getSupabaseAdmin();

    // Get authenticated user ID
    let userId: string;
    try {
        const me = await client.v2.me();
        userId = me.data.id;
    } catch {
        return;
    }

    // Fetch recent tweets with metrics
    try {
        const tweets = await client.v2.userTimeline(userId, {
            max_results: 20,
            'tweet.fields': ['public_metrics', 'created_at', 'text'],
            exclude: ['retweets'],
        });

        if (!tweets.data?.data?.length) return;

        let updated = 0;

        for (const tweet of tweets.data.data) {
            const metrics = tweet.public_metrics;
            if (!metrics) continue;

            // Extract hashtags from tweet text
            const hashtags = (tweet.text.match(/#\w+/g) || []);

            // Determine content type from our logs
            const { data: log } = await supabase
                .from('agent_logs')
                .select('details')
                .eq('model_id', model.id)
                .in('action', ['twitter_auto_post', 'twitter_presence_post', 'twitter_trend_post'])
                .like('details->>tweet_url', `%${tweet.id}%`)
                .limit(1)
                .single();

            const contentType = log?.details?.content_type || 'unknown';

            // Upsert analytics
            await supabase
                .from('twitter_analytics')
                .upsert({
                    model_id: model.id,
                    tweet_id: tweet.id,
                    tweet_text: tweet.text.substring(0, 500),
                    content_type: contentType,
                    hashtags: hashtags,
                    impressions: metrics.impression_count || 0,
                    likes: metrics.like_count || 0,
                    retweets: metrics.retweet_count || 0,
                    reply_count: metrics.reply_count || 0,
                    quotes: metrics.quote_count || 0,
                    bookmarks: metrics.bookmark_count || 0,
                    snapshot_at: new Date().toISOString(),
                }, { onConflict: 'model_id,tweet_id' });

            updated++;
        }

        if (updated > 0) {
            console.log(`  📈 Updated metrics for ${updated} tweets (@${model.id.substring(0, 8)})`);
        }

        // Generate learning insights
        await generateInsights(model);

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429')) {
            console.log(`  ⚠️ Rate limited on timeline read, will retry next cycle`);
        } else {
            console.error(`  ❌ Twitter metrics error:`, msg);
        }
    }
}

/**
 * Generate learning insights from accumulated analytics
 */
async function generateInsights(model: {
    id: string;
    phone: string;
    persona: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get last 30 tweets' analytics
    const { data: analytics } = await supabase
        .from('twitter_analytics')
        .select('*')
        .eq('model_id', model.id)
        .order('snapshot_at', { ascending: false })
        .limit(30);

    if (!analytics || analytics.length < 5) return; // Need minimum data

    // Build summary for Claude
    const summary = analytics.map(a =>
        `Tweet: "${(a.tweet_text || '').substring(0, 60)}..." | Type: ${a.content_type} | ` +
        `👍${a.likes} 🔁${a.retweets} 💬${a.reply_count} 👁${a.impressions} | Tags: ${(a.hashtags || []).join(', ')}`
    ).join('\n');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            system: `You are analyzing Twitter performance data for a content creator.
Generate a concise 3-5 bullet point summary of insights.

Focus on:
- Which content types get most engagement
- Which hashtags perform best
- Best patterns (time, tone, emoji usage)
- Actionable tips for next tweets

Be specific with numbers. Output in Portuguese (Brazilian).`,
            messages: [{
                role: 'user',
                content: `Analyze these ${analytics.length} tweets:\n\n${summary}`,
            }],
        });

        const insights = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

        if (insights) {
            // Save insights
            await supabase.from('agent_logs').insert({
                model_id: model.id,
                action: 'twitter_learning_insights',
                platform: 'twitter',
                details: { insights, tweet_count: analytics.length },
            });

            // Notify model weekly (check if last notification was > 7 days ago)
            const { data: lastNotif } = await supabase
                .from('agent_logs')
                .select('created_at')
                .eq('model_id', model.id)
                .eq('action', 'twitter_learning_notification')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            const daysSinceNotif = lastNotif
                ? (Date.now() - new Date(lastNotif.created_at).getTime()) / (1000 * 60 * 60 * 24)
                : 999;

            if (daysSinceNotif >= 7 && model.phone) {
                await sendTelegramMessage(
                    Number(model.phone),
                    `📈 *Relatório Twitter Semanal*\n\n${insights}`
                );
                await supabase.from('agent_logs').insert({
                    model_id: model.id,
                    action: 'twitter_learning_notification',
                    details: {},
                });
            }
        }
    } catch {
        // Non-critical
    }
}

/**
 * Get latest learning insights for a model (used by other engines)
 */
export async function getTwitterInsights(modelId: string): Promise<string | null> {
    const supabase = getSupabaseAdmin();

    const { data } = await supabase
        .from('agent_logs')
        .select('details')
        .eq('model_id', modelId)
        .eq('action', 'twitter_learning_insights')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    return data?.details?.insights as string | null;
}
