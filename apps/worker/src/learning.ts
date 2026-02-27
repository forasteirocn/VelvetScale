import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Performance Learning
// Learns from post results to improve over time
// Runs weekly (or on demand)
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let learningInterval: ReturnType<typeof setInterval> | null = null;

export function startLearningEngine(): void {
    if (learningInterval) return;

    console.log('📊 Learning Engine iniciado (atualiza 1x por dia)');

    // First run after 20 minutes
    setTimeout(() => {
        updatePerformanceMetrics();
        learningInterval = setInterval(updatePerformanceMetrics, 24 * 60 * 60 * 1000); // Daily
    }, 20 * 60 * 1000);
}

export function stopLearningEngine(): void {
    if (learningInterval) {
        clearInterval(learningInterval);
        learningInterval = null;
    }
}

// =============================================
// 1. Update post metrics (upvotes/comments)
// =============================================

/**
 * Updates engagement metrics for recent posts by checking Reddit
 * and generates learning summaries
 */
async function updatePerformanceMetrics(): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona')
        .eq('status', 'active');

    if (!models?.length) return;

    for (const model of models) {
        try {
            // 1. Update individual post metrics
            await updatePostMetrics(model.id);

            // 2. Recalculate sub_performance aggregates
            await recalculateSubPerformance(model.id);

            // 3. Generate learning summary
            await generateLearningSummary(model.id);
        } catch (err) {
            console.error(`❌ Learning error for ${model.id}:`, err);
        }
    }
}

/**
 * Fetch current upvotes/comments for recent posts from Reddit
 */
async function updatePostMetrics(modelId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get published posts from last 7 days that haven't been checked in 6h
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const { data: posts } = await supabase
        .from('posts')
        .select('id, external_url, upvotes, comments_count')
        .eq('model_id', modelId)
        .eq('status', 'published')
        .eq('platform', 'reddit')
        .gte('published_at', sevenDaysAgo)
        .not('external_url', 'is', null)
        .or(`last_checked_at.is.null,last_checked_at.lt.${sixHoursAgo}`);

    if (!posts?.length) return;

    let updated = 0;
    for (const post of posts) {
        if (!post.external_url) continue;

        try {
            const metrics = await fetchPostMetrics(post.external_url);
            if (metrics) {
                await supabase
                    .from('posts')
                    .update({
                        upvotes: metrics.upvotes,
                        comments_count: metrics.comments,
                        engagement: {
                            upvotes: metrics.upvotes,
                            comments: metrics.comments,
                            upvote_ratio: metrics.upvoteRatio,
                        },
                        last_checked_at: new Date().toISOString(),
                    })
                    .eq('id', post.id);
                updated++;
            }
        } catch { continue; }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 1500));
    }

    if (updated > 0) {
        console.log(`  📊 Updated metrics for ${updated} posts (model ${modelId.substring(0, 8)})`);
    }
}

/**
 * Fetch upvotes and comments from a Reddit post via JSON API
 */
async function fetchPostMetrics(postUrl: string): Promise<{ upvotes: number; comments: number; upvoteRatio: number } | null> {
    try {
        const jsonUrl = postUrl.replace(/\/?$/, '.json');
        const response = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
            timeout: 10000,
        });

        const postData = response.data?.[0]?.data?.children?.[0]?.data;
        if (!postData) return null;

        return {
            upvotes: postData.score || 0,
            comments: postData.num_comments || 0,
            upvoteRatio: postData.upvote_ratio || 0,
        };
    } catch {
        return null;
    }
}

// =============================================
// 2. Recalculate sub performance aggregates
// =============================================

async function recalculateSubPerformance(modelId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get all published posts grouped by subreddit
    const { data: posts } = await supabase
        .from('posts')
        .select('subreddit, upvotes, comments_count, published_at, status, title_style')
        .eq('model_id', modelId)
        .eq('platform', 'reddit')
        .in('status', ['published', 'deleted']);

    if (!posts?.length) return;

    // Group by subreddit
    const subStats: Record<string, {
        total: number;
        upvotes: number[];
        comments: number[];
        removed: number;
        hours: number[];
        styleUpvotes: Record<string, { total: number; upvotes: number }>;
    }> = {};

    for (const post of posts) {
        if (!post.subreddit) continue;
        if (!subStats[post.subreddit]) {
            subStats[post.subreddit] = { total: 0, upvotes: [], comments: [], removed: 0, hours: [], styleUpvotes: {} };
        }

        const stats = subStats[post.subreddit];
        stats.total++;

        if (post.status === 'deleted') {
            stats.removed++;
        } else {
            stats.upvotes.push(post.upvotes || 0);
            stats.comments.push(post.comments_count || 0);
            if (post.published_at) {
                stats.hours.push(new Date(post.published_at).getUTCHours());
            }
            // Track upvotes per title style
            const style = (post as any).title_style || 'default';
            if (!stats.styleUpvotes[style]) {
                stats.styleUpvotes[style] = { total: 0, upvotes: 0 };
            }
            stats.styleUpvotes[style].total++;
            stats.styleUpvotes[style].upvotes += (post.upvotes || 0);
        }
    }

    // Upsert performance for each sub
    for (const [sub, stats] of Object.entries(subStats)) {
        const avgUpvotes = stats.upvotes.length > 0
            ? stats.upvotes.reduce((a, b) => a + b, 0) / stats.upvotes.length
            : 0;
        const avgComments = stats.comments.length > 0
            ? stats.comments.reduce((a, b) => a + b, 0) / stats.comments.length
            : 0;

        // Find best posting hour (hour with highest avg upvotes)
        let bestHour: number | null = null;
        if (stats.hours.length >= 3) {
            const hourCounts: Record<number, { total: number; upvotes: number }> = {};
            for (let i = 0; i < stats.hours.length; i++) {
                const h = stats.hours[i];
                if (!hourCounts[h]) hourCounts[h] = { total: 0, upvotes: 0 };
                hourCounts[h].total++;
                hourCounts[h].upvotes += stats.upvotes[i] || 0;
            }
            let bestAvg = 0;
            for (const [hour, data] of Object.entries(hourCounts)) {
                const avg = data.upvotes / data.total;
                if (avg > bestAvg) {
                    bestAvg = avg;
                    bestHour = parseInt(hour);
                }
            }
        }

        // Find best title style
        let bestStyle: string | null = null;
        let bestStyleAvg = 0;
        for (const [style, data] of Object.entries(stats.styleUpvotes)) {
            if (data.total >= 2) {
                const avg = data.upvotes / data.total;
                if (avg > bestStyleAvg) {
                    bestStyleAvg = avg;
                    bestStyle = style;
                }
            }
        }

        await supabase
            .from('sub_performance')
            .upsert({
                model_id: modelId,
                subreddit: sub,
                total_posts: stats.total,
                total_upvotes: stats.upvotes.reduce((a, b) => a + b, 0),
                total_comments: stats.comments.reduce((a, b) => a + b, 0),
                avg_upvotes: Math.round(avgUpvotes * 10) / 10,
                posts_removed: stats.removed,
                best_posting_hour: bestHour,
                best_title_style: bestStyle,
                last_calculated_at: new Date().toISOString(),
            }, { onConflict: 'model_id,subreddit' });
    }

    console.log(`  📊 Sub performance updated for ${Object.keys(subStats).length} subs`);
}

// =============================================
// 3. Generate learning summary for Claude
// =============================================

export interface LearningSummary {
    topSubs: Array<{ name: string; avgUpvotes: number; totalPosts: number }>;
    worstSubs: Array<{ name: string; avgUpvotes: number; removalRate: number }>;
    bestHours: number[];
    bestStylePerSub: Record<string, string>; // sub -> best title style
    titlePatterns: { highPerformers: string[]; lowPerformers: string[] };
    overallStats: { totalPosts: number; avgUpvotes: number; avgComments: number };
    generatedAt: string;
}

/**
 * Generate a learning summary that gets passed as context to Claude
 * This is what makes the AI smarter over time
 */
export async function generateLearningSummary(modelId: string): Promise<LearningSummary | null> {
    const supabase = getSupabaseAdmin();

    // Get all sub performance data
    const { data: perfData } = await supabase
        .from('sub_performance')
        .select('*')
        .eq('model_id', modelId)
        .order('avg_upvotes', { ascending: false });

    if (!perfData?.length) return null;

    // Get recent posts with titles for pattern analysis
    const { data: recentPosts } = await supabase
        .from('posts')
        .select('content, upvotes, comments_count, subreddit')
        .eq('model_id', modelId)
        .eq('status', 'published')
        .eq('platform', 'reddit')
        .order('published_at', { ascending: false })
        .limit(50);

    // Top subs
    const topSubs = perfData
        .filter(p => p.total_posts >= 2)
        .slice(0, 5)
        .map(p => ({
            name: p.subreddit,
            avgUpvotes: p.avg_upvotes || 0,
            totalPosts: p.total_posts || 0,
        }));

    // Worst subs (high removal rate or low engagement)
    const worstSubs = perfData
        .filter(p => p.total_posts >= 2)
        .map(p => ({
            name: p.subreddit,
            avgUpvotes: p.avg_upvotes || 0,
            removalRate: p.total_posts > 0 ? (p.posts_removed || 0) / p.total_posts : 0,
        }))
        .filter(p => p.removalRate > 0.2 || p.avgUpvotes < 3)
        .slice(0, 5);

    // Best hours across all subs
    const hours = perfData
        .filter(p => p.best_posting_hour !== null)
        .map(p => p.best_posting_hour as number);
    const bestHours = [...new Set(hours)].slice(0, 5);

    // Best title style per sub
    const bestStylePerSub: Record<string, string> = {};
    for (const p of perfData) {
        if ((p as any).best_title_style) {
            bestStylePerSub[p.subreddit] = (p as any).best_title_style;
        }
    }

    // Title pattern analysis
    const sortedPosts = [...(recentPosts || [])].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    const highPerformers = sortedPosts.slice(0, 5).map(p => p.content?.substring(0, 80) || '');
    const lowPerformers = sortedPosts.slice(-5).map(p => p.content?.substring(0, 80) || '');

    // Overall stats
    const totalPosts = perfData.reduce((a, p) => a + (p.total_posts || 0), 0);
    const totalUpvotes = perfData.reduce((a, p) => a + (p.total_upvotes || 0), 0);
    const totalComments = perfData.reduce((a, p) => a + (p.total_comments || 0), 0);

    const summary: LearningSummary = {
        topSubs,
        worstSubs,
        bestHours,
        bestStylePerSub,
        titlePatterns: { highPerformers, lowPerformers },
        overallStats: {
            totalPosts,
            avgUpvotes: totalPosts > 0 ? Math.round(totalUpvotes / totalPosts) : 0,
            avgComments: totalPosts > 0 ? Math.round(totalComments / totalPosts) : 0,
        },
        generatedAt: new Date().toISOString(),
    };

    // Store in agent_logs for reference
    await supabase.from('agent_logs').insert({
        model_id: modelId,
        action: 'learning_summary',
        details: summary,
    });

    console.log(`  📊 Learning summary: ${totalPosts} posts, avg ${summary.overallStats.avgUpvotes} upvotes`);

    return summary;
}

/**
 * Get the latest learning summary for a model
 * Used by strategy.ts to pass context to Claude
 */
export async function getLearningSummary(modelId: string): Promise<LearningSummary | null> {
    const supabase = getSupabaseAdmin();

    const { data } = await supabase
        .from('agent_logs')
        .select('details')
        .eq('model_id', modelId)
        .eq('action', 'learning_summary')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (data?.details) {
        return data.details as unknown as LearningSummary;
    }

    // Generate fresh if none exists
    return generateLearningSummary(modelId);
}
