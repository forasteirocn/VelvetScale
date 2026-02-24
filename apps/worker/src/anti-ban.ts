import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Anti-Ban Intelligence
// Protects accounts from bans and removals
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let antiBanInterval: ReturnType<typeof setInterval> | null = null;

export function startAntiBanMonitor(): void {
    if (antiBanInterval) return;

    console.log('🛡️ Anti-Ban Monitor iniciado (verifica a cada 1h)');

    // First run after 15 minutes
    setTimeout(() => {
        checkRemovedPosts();
        antiBanInterval = setInterval(checkRemovedPosts, 60 * 60 * 1000); // Every 1h
    }, 15 * 60 * 1000);
}

export function stopAntiBanMonitor(): void {
    if (antiBanInterval) {
        clearInterval(antiBanInterval);
        antiBanInterval = null;
    }
}

// =============================================
// 1. Fetch and cache subreddit rules
// =============================================

interface SubRules {
    allowsNSFW: boolean;
    requiresFlair: boolean;
    requiresVerification: boolean;
    minKarma: number | null;
    minAccountAge: string | null;
    postingFrequency: string | null;
    bannedWords: string[];
    titleRules: string[];
    otherRules: string[];
    rawRules: string;
}

/**
 * Fetch subreddit rules from Reddit JSON API
 * Caches them in the subreddits table
 */
export async function getSubRules(subredditName: string): Promise<SubRules | null> {
    const supabase = getSupabaseAdmin();

    // Check cache first (rules_summary updated in last 7 days)
    const { data: cached } = await supabase
        .from('subreddits')
        .select('rules_summary, posting_rules')
        .eq('name', subredditName)
        .single();

    if (cached?.posting_rules) {
        const rules = cached.posting_rules as Record<string, unknown>;
        const cachedAt = rules._cached_at as string | undefined;
        if (cachedAt) {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            if (new Date(cachedAt) > sevenDaysAgo) {
                return rules as unknown as SubRules;
            }
        }
    }

    // Fetch fresh rules from Reddit
    try {
        const [rulesRes, aboutRes] = await Promise.all([
            axios.get(`https://www.reddit.com/r/${subredditName}/about/rules.json`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                timeout: 10000,
            }),
            axios.get(`https://www.reddit.com/r/${subredditName}/about.json`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                timeout: 10000,
            }),
        ]);

        const rawRulesList = rulesRes.data?.rules || [];
        const aboutData = aboutRes.data?.data || {};

        const ruleTexts = rawRulesList.map((r: { short_name?: string; description?: string }) =>
            `${r.short_name || ''}: ${r.description || ''}`.trim()
        );

        const rawRules = ruleTexts.join('\n');

        // Use Claude to parse rules into structured format
        const parsed = await parseRulesWithClaude(subredditName, rawRules, aboutData);

        // Cache in DB
        const rulesData = {
            ...parsed,
            rawRules,
            _cached_at: new Date().toISOString(),
        };

        await supabase
            .from('subreddits')
            .update({
                posting_rules: rulesData,
                rules_summary: rawRules.substring(0, 500),
            })
            .eq('name', subredditName);

        console.log(`  🛡️ Rules cached for r/${subredditName}`);
        return parsed;
    } catch (err) {
        console.error(`  ⚠️ Failed to fetch rules for r/${subredditName}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Use Claude to parse subreddit rules into structured format
 */
async function parseRulesWithClaude(
    subName: string,
    rawRules: string,
    aboutData: Record<string, unknown>
): Promise<SubRules> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 400,
            system: `Parse these subreddit rules into structured JSON. Be concise.
Respond with ONLY valid JSON:
{
  "allowsNSFW": true/false,
  "requiresFlair": true/false,
  "requiresVerification": true/false,
  "minKarma": number or null,
  "minAccountAge": "string" or null,
  "postingFrequency": "max X per day/week" or null,
  "bannedWords": ["word1", "word2"],
  "titleRules": ["rule1"],
  "otherRules": ["important rule 1"]
}`,
            messages: [{
                role: 'user',
                content: `Subreddit: r/${subName}
NSFW: ${aboutData.over18 || false}
Subscribers: ${aboutData.subscribers || 0}
Description: ${(aboutData.public_description as string || '').substring(0, 300)}

Rules:
${rawRules.substring(0, 2000)}

Parse into structured JSON.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as SubRules;
        }
    } catch { /* fall through */ }

    // Default when parsing fails
    return {
        allowsNSFW: true,
        requiresFlair: false,
        requiresVerification: false,
        minKarma: null,
        minAccountAge: null,
        postingFrequency: null,
        bannedWords: [],
        titleRules: [],
        otherRules: [],
        rawRules: rawRules.substring(0, 500),
    };
}

// =============================================
// 2. Validate a post before submitting
// =============================================

interface ValidationResult {
    isOk: boolean;
    warnings: string[];
    blockers: string[];  // Things that WILL get the post removed
    suggestions: string[];
}

/**
 * Validate if a post is safe to submit to a subreddit
 * Checks rules compliance before posting
 */
export async function validatePostBeforeSubmit(
    subredditName: string,
    title: string,
    isNsfw: boolean,
    modelId?: string
): Promise<ValidationResult> {
    const rules = await getSubRules(subredditName);

    const result: ValidationResult = {
        isOk: true,
        warnings: [],
        blockers: [],
        suggestions: [],
    };

    if (!rules) {
        result.warnings.push('Could not fetch sub rules, posting anyway');
        return result;
    }

    // Check NSFW compatibility
    if (isNsfw && !rules.allowsNSFW) {
        result.isOk = false;
        result.blockers.push(`r/${subredditName} does NOT allow NSFW content`);
    }

    // Check if verification is required
    if (rules.requiresVerification) {
        result.warnings.push(`r/${subredditName} requires verification — post may be removed`);
    }

    // Check title against banned words
    const titleLower = title.toLowerCase();
    for (const word of rules.bannedWords) {
        if (titleLower.includes(word.toLowerCase())) {
            result.isOk = false;
            result.blockers.push(`Title contains banned word: "${word}"`);
        }
    }

    // Check posting frequency
    if (rules.postingFrequency && modelId) {
        const supabase = getSupabaseAdmin();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const { count } = await supabase
            .from('posts')
            .select('*', { count: 'exact', head: true })
            .eq('model_id', modelId)
            .eq('subreddit', subredditName)
            .eq('status', 'published')
            .gte('published_at', oneDayAgo);

        const postsToday = count || 0;
        if (postsToday >= 1) {
            result.warnings.push(`Already posted ${postsToday}x in r/${subredditName} today`);
        }
    }

    // Check if sub has high removal rate
    if (modelId) {
        const supabase = getSupabaseAdmin();
        const { data: perf } = await supabase
            .from('sub_performance')
            .select('total_posts, posts_removed')
            .eq('model_id', modelId)
            .eq('subreddit', subredditName)
            .single();

        if (perf && perf.total_posts > 3) {
            const removalRate = (perf.posts_removed || 0) / perf.total_posts;
            if (removalRate > 0.5) {
                result.isOk = false;
                result.blockers.push(`High removal rate (${Math.round(removalRate * 100)}%) — sub likely banning/removing our posts`);
            } else if (removalRate > 0.25) {
                result.warnings.push(`Moderate removal rate (${Math.round(removalRate * 100)}%) — be careful`);
            }
        }
    }

    // Check flair requirement
    if (rules.requiresFlair) {
        result.suggestions.push('This sub requires flair — make sure to set one');
    }

    // Log validation
    if (!result.isOk) {
        console.log(`  🛡️ POST BLOCKED for r/${subredditName}: ${result.blockers.join(', ')}`);
    } else if (result.warnings.length > 0) {
        console.log(`  ⚠️ Warnings for r/${subredditName}: ${result.warnings.join(', ')}`);
    } else {
        console.log(`  ✅ Post validated for r/${subredditName}`);
    }

    return result;
}

// =============================================
// 3. Check for removed posts (runs hourly)
// =============================================

/**
 * Check recent posts to see if any were removed
 * Updates sub_performance and auto-adjusts cooldowns
 */
async function checkRemovedPosts(): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get posts from the last 48h that are published
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: recentPosts } = await supabase
        .from('posts')
        .select('id, model_id, external_url, subreddit, status, content')
        .eq('status', 'published')
        .eq('platform', 'reddit')
        .gte('published_at', twoDaysAgo)
        .not('external_url', 'is', null);

    if (!recentPosts?.length) return;

    let removedCount = 0;

    for (const post of recentPosts) {
        if (!post.external_url) continue;

        try {
            // Check if post is still live via Reddit JSON API
            const isLive = await checkPostIsLive(post.external_url);

            if (!isLive) {
                removedCount++;
                console.log(`  🛡️ Post removed: ${post.external_url}`);

                // Update post status
                await supabase
                    .from('posts')
                    .update({ status: 'deleted', error_message: 'Post removed by subreddit moderators' })
                    .eq('id', post.id);

                // Increment posts_removed counter
                if (post.subreddit) {
                    // Increment posts_removed counter
                    try {
                        const { data: perf } = await supabase
                            .from('sub_performance')
                            .select('posts_removed')
                            .eq('model_id', post.model_id)
                            .eq('subreddit', post.subreddit)
                            .single();

                        await supabase
                            .from('sub_performance')
                            .upsert({
                                model_id: post.model_id,
                                subreddit: post.subreddit,
                                posts_removed: (perf?.posts_removed || 0) + 1,
                            }, { onConflict: 'model_id,subreddit' });
                    } catch { /* ignore increment errors */ }

                    // Auto-adjust cooldown based on removal count
                    await adjustCooldown(post.model_id, post.subreddit);
                }

                // Notify model
                const { data: model } = await supabase
                    .from('models')
                    .select('phone')
                    .eq('id', post.model_id)
                    .single();

                if (model?.phone) {
                    const safeSub = post.subreddit?.replace(/_/g, '\\_') || 'unknown';
                    await sendTelegramMessage(
                        Number(model.phone),
                        `⚠️ Post removido em r/${safeSub}!\nO sub moderou/removeu seu post. Vou ajustar a estrategia automaticamente.`
                    );
                }
            }
        } catch (err) {
            // Network errors — skip silently
            continue;
        }
    }

    if (removedCount > 0) {
        console.log(`🛡️ Anti-Ban: ${removedCount} removed posts detected`);
    }
}

/**
 * Check if a Reddit post is still live
 */
async function checkPostIsLive(postUrl: string): Promise<boolean> {
    try {
        // Convert to JSON endpoint
        const jsonUrl = postUrl.replace(/\/?$/, '.json');
        const response = await axios.get(jsonUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
            timeout: 10000,
            validateStatus: (status) => status < 500,
        });

        if (response.status === 404 || response.status === 403) {
            return false;
        }

        // Check if post was removed (still accessible but content removed)
        const postData = response.data?.[0]?.data?.children?.[0]?.data;
        if (!postData) return false;

        // These indicate the post was removed
        if (postData.removed_by_category || postData.removed === true) return false;
        if (postData.selftext === '[removed]') return false;
        if (postData.banned_by) return false;

        return true;
    } catch {
        // On error, assume post is still live (don't false-flag)
        return true;
    }
}

// =============================================
// 4. Auto-adjust cooldowns
// =============================================

/**
 * Adjust cooldown for a subreddit based on removal history
 * More removals = longer cooldown, eventual auto-ban
 */
async function adjustCooldown(modelId: string, subreddit: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: perf } = await supabase
        .from('sub_performance')
        .select('total_posts, posts_removed')
        .eq('model_id', modelId)
        .eq('subreddit', subreddit)
        .single();

    if (!perf) return;

    const removedCount = perf.posts_removed || 0;
    const totalPosts = perf.total_posts || 0;
    const removalRate = totalPosts > 0 ? removedCount / totalPosts : 0;

    let newCooldown = 24; // Default: 24h
    let shouldBan = false;

    if (removedCount >= 3 || removalRate > 0.6) {
        // 3+ removals or 60%+ removal rate → auto-ban
        shouldBan = true;
        console.log(`  🚫 Auto-banning r/${subreddit} (${removedCount} removals, ${Math.round(removalRate * 100)}% rate)`);
    } else if (removedCount >= 2 || removalRate > 0.4) {
        // 2 removals or 40%+ → increase cooldown to 72h
        newCooldown = 72;
        console.log(`  ⏰ Increasing cooldown for r/${subreddit} to 72h`);
    } else if (removedCount >= 1) {
        // 1 removal → increase cooldown to 48h
        newCooldown = 48;
        console.log(`  ⏰ Increasing cooldown for r/${subreddit} to 48h`);
    }

    if (shouldBan) {
        await supabase
            .from('subreddits')
            .update({ is_banned: true, cooldown_hours: 168 }) // 1 week
            .eq('model_id', modelId)
            .eq('name', subreddit);
    } else {
        await supabase
            .from('subreddits')
            .update({ cooldown_hours: newCooldown })
            .eq('model_id', modelId)
            .eq('name', subreddit);
    }
}
