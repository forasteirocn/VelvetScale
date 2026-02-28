import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import { improveCaption, pickBestSubForCaption, analyzeImage, generateABTitles, type ImageAnalysis, type SubRulesContext } from './integrations/claude';
import { validatePostBeforeSubmit, getSubRules, validateTitleFormat } from './anti-ban';
import { getLearningSummary, type LearningSummary } from './learning';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Strategy Engine
// AI-powered decisions for every post
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

interface SubScore {
    name: string;
    score: number;
    reason: string;
    bestHourUTC: number;
}

interface PostStrategy {
    subreddit: string;
    title: string;
    scheduledFor: Date;
    reason: string;
}

/**
 * Build SubRulesContext for a subreddit — fetches rules, top titles, and removal history
 */
async function buildSubRulesContext(subreddit: string, modelId?: string): Promise<SubRulesContext | null> {
    try {
        const rules = await getSubRules(subreddit);
        if (!rules) return null;

        const context: SubRulesContext = {
            titleRules: rules.titleRules || [],
            bannedWords: rules.bannedWords || [],
            otherRules: rules.otherRules || [],
        };

        // Phase 4: Fetch top titles from sub as style reference
        try {
            const resp = await axios.get(`https://www.reddit.com/r/${subreddit}/hot.json?limit=8`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                timeout: 10000,
            });
            const posts = resp.data?.data?.children || [];
            context.topTitles = posts
                .filter((p: any) => p.kind === 't3' && p.data?.title && p.data?.score > 10)
                .map((p: any) => p.data.title as string)
                .slice(0, 5);
        } catch { /* ignore */ }

        // Phase 3: Fetch removal history for this sub
        if (modelId) {
            try {
                const supabase = getSupabaseAdmin();
                const { data: removedPosts } = await supabase
                    .from('posts')
                    .select('title, removal_reason')
                    .eq('model_id', modelId)
                    .eq('subreddit', subreddit)
                    .eq('status', 'deleted')
                    .not('removal_reason', 'is', null)
                    .order('published_at', { ascending: false })
                    .limit(5);

                if (removedPosts && removedPosts.length > 0) {
                    context.removalHistory = removedPosts.map(p => ({
                        title: p.title || '(unknown)',
                        reason: p.removal_reason || 'unknown',
                    }));
                }
            } catch { /* ignore */ }
        }

        return context;
    } catch {
        return null;
    }
}

/**
 * The main entry point: analyze a photo and create an intelligent posting strategy
 * 1 photo → 3 posts in 3 different subs at optimal times
 */
export async function analyzeAndSchedule(
    modelId: string,
    photos: Array<{ url: string; caption: string }>,
    chatId: number
): Promise<void> {
    const supabase = getSupabaseAdmin();

    // --- Gather all intelligence ---

    // 1. Get model info
    const { data: model } = await supabase
        .from('models')
        .select('*')
        .eq('id', modelId)
        .single();

    if (!model) return;

    // 2. Get all approved subs (not banned)
    const { data: subs } = await supabase
        .from('subreddits')
        .select('name, last_posted_at, cooldown_hours, engagement_score, is_banned, member_count, needs_verification')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('is_banned', false)
        .or('needs_verification.is.null,needs_verification.eq.false');

    if (!subs?.length) {
        await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit configurado. Use "encontrar subreddits" primeiro.');
        return;
    }

    // 3. Get posting history (last 30 days) — performance data
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: recentPosts } = await supabase
        .from('posts')
        .select('subreddit, upvotes, comments_count, status, published_at')
        .eq('model_id', modelId)
        .eq('platform', 'reddit')
        .gte('published_at', thirtyDaysAgo.toISOString())
        .order('published_at', { ascending: false })
        .limit(50);

    // 4. Get sub performance metrics
    const { data: perfData } = await supabase
        .from('sub_performance')
        .select('*')
        .eq('model_id', modelId);

    // 5. Get recently scheduled posts (avoid double-posting to same sub)
    const { data: scheduled } = await supabase
        .from('scheduled_posts')
        .select('target_subreddit, scheduled_for')
        .eq('model_id', modelId)
        .in('status', ['ready', 'queued', 'processing']);

    const recentlyScheduledSubs = new Set(scheduled?.map(s => s.target_subreddit) || []);

    // --- Build context for Claude ---
    const subContext = subs.map(sub => {
        const posts = recentPosts?.filter(p => p.subreddit === sub.name) || [];
        const perf = perfData?.find(p => p.subreddit === sub.name);
        const totalUpvotes = posts.reduce((sum, p) => sum + (p.upvotes || 0), 0);
        const avgUpvotes = posts.length > 0 ? Math.round(totalUpvotes / posts.length) : 0;
        const lastPosted = sub.last_posted_at ? timeSince(sub.last_posted_at) : 'nunca';
        const isOnCooldown = recentlyScheduledSubs.has(sub.name);

        return {
            name: sub.name,
            avgUpvotes,
            totalPosts: posts.length,
            postsRemoved: perf?.posts_removed || 0,
            lastPosted,
            memberCount: sub.member_count || 0,
            engagementScore: sub.engagement_score || 0,
            isOnCooldown,
            bestHour: perf?.best_posting_hour,
        };
    });

    // Filter out subs on cooldown
    const availableSubs = subContext.filter(s => !s.isOnCooldown);
    if (availableSubs.length === 0) {
        await sendTelegramMessage(chatId, '⏳ Todos os subs estão em cooldown. Tente mais tarde!');
        return;
    }

    // Process each photo
    for (const photo of photos) {
        await sendTelegramMessage(chatId, '🧠 Analisando estrategia para sua foto...');

        // Analyze the image with Claude Vision
        const imageAnalysis = await analyzeImage(photo.url);

        const strategy = await getPostingStrategy(
            photo.caption,
            availableSubs,
            model.bio || '',
            model.persona || '',
            imageAnalysis
        );

        if (strategy.length === 0) {
            await sendTelegramMessage(chatId, '⚠️ Nao consegui definir uma estrategia agora. Tente novamente.');
            continue;
        }

        // Schedule each post from the strategy
        const scheduledPosts: Array<{ sub: string; time: Date; title: string; reason: string }> = [];

        // Generate A/B title variants if posting to multiple subs
        let titleVariants: Array<{ title: string; style: string }> = [];
        if (strategy.length > 1) {
            try {
                const subRulesCtx = await buildSubRulesContext(strategy[0].subreddit, modelId);
                const abTitles = await generateABTitles(
                    photo.caption || '🔥',
                    strategy[0].subreddit,
                    model.bio || '',
                    model.persona || '',
                    imageAnalysis,
                    subRulesCtx
                );
                titleVariants = abTitles;
                console.log(`  🎯 A/B titles: ${abTitles.map(t => `"${t.title}" (${t.style})`).join(', ')}`);
            } catch { /* fall back to single caption */ }
        }

        for (let planIndex = 0; planIndex < strategy.length; planIndex++) {
            const plan = strategy[planIndex];

            // Use A/B variant if available, otherwise improve caption
            let title = plan.title;
            let titleStyle = 'default';
            if (titleVariants.length > planIndex) {
                title = titleVariants[planIndex].title;
                titleStyle = titleVariants[planIndex].style;
            } else {
                try {
                    const subRulesCtx = await buildSubRulesContext(plan.subreddit, modelId);
                    const improved = await improveCaption(
                        photo.caption || '🔥',
                        plan.subreddit,
                        model.bio || '',
                        model.persona || '',
                        { onlyfans: model.onlyfans_url, privacy: model.privacy_url },
                        imageAnalysis,
                        subRulesCtx
                    );
                    title = improved.title;
                } catch { /* Use Claude's strategy title as fallback */ }
            }

            const { data: post } = await supabase
                .from('scheduled_posts')
                .insert({
                    model_id: modelId,
                    photo_url: photo.url,
                    original_caption: photo.caption,
                    improved_title: title,
                    title_style: titleStyle,
                    target_subreddit: plan.subreddit,
                    scheduled_for: plan.scheduledFor.toISOString(),
                    status: 'ready',
                })
                .select('id')
                .single();

            if (post) {
                scheduledPosts.push({
                    sub: plan.subreddit,
                    time: plan.scheduledFor,
                    title,
                    reason: plan.reason,
                });
            }
        }

        // Send intelligent summary to model
        if (scheduledPosts.length > 0) {
            let msg = `🧠 Estrategia definida! ${scheduledPosts.length} post(s):\n\n`;
            for (const sp of scheduledPosts) {
                const brTime = sp.time.toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZone: 'America/Sao_Paulo',
                });
                const safeSub = sp.sub.replace(/_/g, '\\_');
                const safeReason = sp.reason.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 120);
                msg += `${brTime} BRT - r/${safeSub}\n${safeReason}\n\n`;
            }
            msg += 'Posts serao publicados automaticamente.';
            await sendTelegramMessage(chatId, msg);
        }
    }

    // Log
    await supabase.from('agent_logs').insert({
        model_id: modelId,
        action: 'strategic_schedule',
        details: { photos: photos.length },
    });
}

/**
 * Ask Claude for a strategic posting plan
 * Returns top 3 subs with optimal times and justification
 */
async function getPostingStrategy(
    caption: string,
    availableSubs: Array<{
        name: string;
        avgUpvotes: number;
        totalPosts: number;
        postsRemoved: number;
        lastPosted: string;
        memberCount: number;
        engagementScore: number;
        bestHour: number | null | undefined;
    }>,
    modelBio: string,
    persona: string,
    imageAnalysis?: ImageAnalysis | null
): Promise<PostStrategy[]> {
    // Sort by engagement score desc, take top 40 for Claude
    const candidates = [...availableSubs]
        .sort((a, b) => (b.engagementScore + b.avgUpvotes) - (a.engagementScore + a.avgUpvotes))
        .slice(0, 40);

    // Get learning context
    let learningContext = '';
    // We get modelId from the first sub's model context (available in caller)
    // For now we build context from available data

    const subsReport = candidates.map(s =>
        `- r/${s.name}: ${s.totalPosts} posts, avg ${s.avgUpvotes} upvotes, ${s.postsRemoved} removidos, último post: ${s.lastPosted}, ${s.memberCount > 0 ? s.memberCount + ' membros' : 'membros desconhecidos'}`
    ).join('\n');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 800,
            system: `You are an expert Reddit marketing strategist for adult content creators.
Your job is to choose the BEST 3 subreddits for a photo post, with optimal posting times.
${imageAnalysis ? `
IMPORTANT — Photo analysis (what Claude Vision saw):
- BODY PART FOCUS: ${imageAnalysis.bodyPartFocus || 'unknown'}
- POSE: ${imageAnalysis.pose || 'unknown'}
- Camera angle: ${imageAnalysis.cameraAngle || 'unknown'}
- Setting: ${imageAnalysis.setting}
- Outfit: ${imageAnalysis.outfit}
- Mood: ${imageAnalysis.mood}
- Features: ${imageAnalysis.bodyFeatures.join(', ')}
- Best niches: ${imageAnalysis.suggestedNiches.join(', ')}
- Description: ${imageAnalysis.description}

CRITICAL: Only choose subs where the photo's body part focus and pose MATCH the sub's niche.
Example: if body part focus is "breasts", do NOT pick butt-focused subs like FrogButt or pawg.
` : ''}
KEY PRINCIPLES:
- Choose subs where the content will naturally fit the community
- Prioritize subs with high historical performance (upvotes)
- Avoid subs where posts were removed (sign of bad fit or ban)
- Prefer diverse subs (don't pick 3 similar ones — spread reach)
- For timing: peak engagement on NSFW subs is typically 10-14h EST on weekdays, 8-12h EST on weekends
- Space posts at least 2 hours apart to avoid looking like spam
- Consider the day of week: weekdays vs weekends have different peak times

The model's persona: ${persona || 'friendly, flirty, confident'}

Respond with VALID JSON array of exactly 3 objects:
[
  { "subreddit": "SubName", "hourEST": 12, "reason": "Brief reason in Portuguese" },
  ...
]

Keep reasons SHORT (under 100 chars), in Portuguese, explaining WHY this sub.`,
            messages: [{
                role: 'user',
                content: `Legenda da foto: "${caption}"
Bio da modelo: ${modelBio}

Dados dos subreddits disponíveis:
${subsReport}

Data/hora atual (BRT): ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
Dia da semana: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' })}

Escolha os 3 MELHORES subs e horários para esta foto.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        const picks: Array<{ subreddit: string; hourEST: number; reason: string }> = JSON.parse(jsonMatch[0]);

        const now = new Date();
        const strategies: PostStrategy[] = [];

        for (let i = 0; i < Math.min(picks.length, 3); i++) {
            const pick = picks[i];

            // Verify sub exists in our list
            const validSub = availableSubs.find(
                s => s.name.toLowerCase() === pick.subreddit.toLowerCase()
            );
            if (!validSub) continue;

            // Calculate the schedule time
            const scheduledFor = calculateScheduleTime(pick.hourEST, i, now);

            strategies.push({
                subreddit: validSub.name,
                title: caption, // Will be improved later by improveCaption
                scheduledFor,
                reason: pick.reason,
            });

            console.log(`🎯 Strategy: r/${validSub.name} @ ${pick.hourEST}h EST — ${pick.reason}`);
        }

        return strategies;

    } catch (err) {
        console.error('❌ Strategy error:', err);
        return [];
    }
}

/**
 * Calculate when to schedule a post given the target EST hour
 * If the target hour already passed today, schedule for tomorrow
 * Spaces posts by index (2h gap minimum)
 */
function calculateScheduleTime(targetHourEST: number, index: number, now: Date): Date {
    // Add spacing: each subsequent post is 2h later
    const adjustedHour = targetHourEST + (index * 2);

    // Convert EST to UTC (EST = UTC-5)
    const utcHour = adjustedHour + 5;

    const scheduled = new Date(now);
    scheduled.setUTCHours(utcHour, Math.floor(Math.random() * 25) + 5, 0, 0); // Random minute 5-29

    // If this time already passed today, schedule for tomorrow
    if (scheduled <= now) {
        scheduled.setDate(scheduled.getDate() + 1);
    }

    return scheduled;
}

/**
 * Immediate intelligent post — analyzes and posts NOW
 */
export async function intelligentImmediatePost(
    modelId: string,
    photoUrl: string,
    caption: string,
    chatId: number
): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: model } = await supabase
        .from('models')
        .select('*')
        .eq('id', modelId)
        .single();

    if (!model) return;

    const { data: subs } = await supabase
        .from('subreddits')
        .select('name, engagement_score, last_posted_at, is_banned, needs_verification')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('is_banned', false)
        .or('needs_verification.is.null,needs_verification.eq.false');

    if (!subs?.length) {
        await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit configurado.');
        return;
    }

    // Get historical performance
    const { data: perfData } = await supabase
        .from('sub_performance')
        .select('subreddit, avg_upvotes, posts_removed')
        .eq('model_id', modelId);

    const subNames = subs.map(s => s.name);

    // Build context for smart pick
    const subInfo = subs.map(s => {
        const perf = perfData?.find(p => p.subreddit === s.name);
        return `- r/${s.name}: engagement ${s.engagement_score || 0}, avg upvotes ${perf?.avg_upvotes || 0}, removidos ${perf?.posts_removed || 0}`;
    }).join('\n');

    // Get learning context for smarter decisions
    const learning = await getLearningSummary(modelId);
    const learningContext = learning ? `

HISTORICAL PERFORMANCE DATA (learn from this):
- Top subs: ${learning.topSubs.map(s => `r/${s.name} (avg ${s.avgUpvotes} upvotes)`).join(', ')}
- Avoid subs: ${learning.worstSubs.map(s => `r/${s.name} (${Math.round(s.removalRate * 100)}% removal rate)`).join(', ') || 'none'}
- Best hours (UTC): ${learning.bestHours.join(', ') || 'no data yet'}
- Top titles: ${learning.titlePatterns.highPerformers.slice(0, 3).map(t => `"${t}"`).join(', ') || 'no data'}
- Overall: ${learning.overallStats.totalPosts} posts, avg ${learning.overallStats.avgUpvotes} upvotes` : '';

    await sendTelegramMessage(chatId, '🧠 Analisando melhor sub para sua foto...');

    // Analyze the image with Claude Vision
    const imageAnalysis = await analyzeImage(photoUrl);

    // Ask Claude for the single best sub (with visual context)
    let targetSub: string;
    try {
        // Build visual context for the prompt
        const visualInfo = imageAnalysis
            ? `\n\nPhoto analysis:\n- Setting: ${imageAnalysis.setting}\n- Outfit: ${imageAnalysis.outfit}\n- Mood: ${imageAnalysis.mood}\n- Features: ${imageAnalysis.bodyFeatures.join(', ')}\n- Niches: ${imageAnalysis.suggestedNiches.join(', ')}\n- Description: ${imageAnalysis.description}`
            : '';

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            system: `Pick the single BEST subreddit for this photo post.
Consider: ${imageAnalysis ? 'the PHOTO ANALYSIS (most important), ' : ''}caption vibe, subreddit culture fit, historical performance.
${imageAnalysis ? 'Match the photo\'s visual characteristics to the subreddit\'s niche.' : ''}
${learningContext ? 'Use the HISTORICAL PERFORMANCE DATA to prefer subs that perform well and avoid subs with high removal rates.' : ''}
Respond with ONLY the subreddit name. No "r/", no explanation.`,
            messages: [{
                role: 'user',
                content: `Caption: "${caption}"

Available subs with performance data:
${subInfo}${imageAnalysis
                        ? `\n\nPhoto analysis:\n- Setting: ${imageAnalysis.setting}\n- Outfit: ${imageAnalysis.outfit}\n- Mood: ${imageAnalysis.mood}\n- Features: ${imageAnalysis.bodyFeatures.join(', ')}\n- Niches: ${imageAnalysis.suggestedNiches.join(', ')}\n- Description: ${imageAnalysis.description}`
                        : ''}${learningContext}

Which ONE sub is the best match?`,
            }],
        });

        const chosen = response.content[0].type === 'text'
            ? response.content[0].text.trim().replace(/^r\//, '').replace(/[^a-zA-Z0-9_]/g, '')
            : '';

        targetSub = subNames.find(s => s.toLowerCase() === chosen.toLowerCase()) || subNames[Math.floor(Math.random() * subNames.length)];
        console.log(`🎯 Claude chose: r/${targetSub} for immediate post`);
    } catch {
        targetSub = subNames[Math.floor(Math.random() * subNames.length)];
    }

    const safeSub = targetSub.replace(/_/g, '\\_');
    await sendTelegramMessage(chatId, `Postando agora em r/${safeSub}...`);

    // Improve caption (with visual context)
    let title = caption;
    try {
        const subRulesCtx = await buildSubRulesContext(targetSub, modelId);
        const improved = await improveCaption(
            caption || '🔥',
            targetSub,
            model.bio || '',
            model.persona || '',
            { onlyfans: model.onlyfans_url, privacy: model.privacy_url },
            imageAnalysis,
            subRulesCtx
        );
        title = improved.title;
        console.log(`  📝 Título gerado: "${title}"`);
        if (subRulesCtx?.titleRules?.length) {
            console.log(`  📋 Regras aplicadas: ${subRulesCtx.titleRules.join(', ')}`);
        }

        // Phase 2: Validate title format and retry if violations found
        const titleCheck = await validateTitleFormat(title, targetSub);
        if (!titleCheck.ok) {
            console.log(`  🔄 Title rejected: ${titleCheck.violations.join(', ')}`);
            for (let retry = 0; retry < 2; retry++) {
                try {
                    const retryImproved = await improveCaption(
                        `${caption}\n\n⚠️ PREVIOUS TITLE WAS REJECTED: "${title}"\nVIOLATIONS: ${titleCheck.violations.join(', ')}\nGenerate a NEW title that fixes these issues.`,
                        targetSub,
                        model.bio || '',
                        model.persona || '',
                        { onlyfans: model.onlyfans_url, privacy: model.privacy_url },
                        imageAnalysis,
                        subRulesCtx
                    );
                    title = retryImproved.title;
                    console.log(`  🔄 Retry ${retry + 1}: "${title}"`);
                    const recheck = await validateTitleFormat(title, targetSub);
                    if (recheck.ok) {
                        console.log(`  ✅ Title passed validation`);
                        break;
                    }
                } catch { break; }
            }
        }
    } catch { /* use original */ }

    // Validate post against sub rules before submitting
    console.log(`🛡️ Validando post para r/${targetSub}...`);
    const validation = await validatePostBeforeSubmit(targetSub, title, true, modelId);

    if (!validation.isOk) {
        const blockerMsg = validation.blockers.join(', ');
        console.log(`  🚫 Post blocked: ${blockerMsg}`);
        await sendTelegramMessage(chatId, `⚠️ Post bloqueado para r/${safeSub}: ${blockerMsg}\nTente outro sub.`);
        return;
    }

    if (validation.warnings.length > 0) {
        console.log(`  ⚠️ Warnings: ${validation.warnings.join(', ')}`);
    }

    // Post via Playwright — with retry on different subs
    const { submitRedditImagePost } = await import('./integrations/reddit');
    let triedSubs = [targetSub];
    let currentSub = targetSub;
    let currentTitle = title;
    let result = await submitRedditImagePost(modelId, currentSub, currentTitle, photoUrl, true);

    // Retry up to 2 more times with different subs if failed
    const MAX_RETRIES = 2;
    let retryCount = 0;

    while (!result.success && retryCount < MAX_RETRIES) {
        const errorLower = (result.error || '').toLowerCase();
        const isRetryable = errorLower.includes('private') || errorLower.includes('restricted') ||
            errorLower.includes('banned') || errorLower.includes('not_allowed') ||
            errorLower.includes('timeout') || errorLower.includes('upload');

        if (!isRetryable) break;

        retryCount++;
        console.log(`  🔄 Retry ${retryCount}/${MAX_RETRIES} — choosing another sub...`);

        // Get remaining subs (exclude already tried)
        const remainingSubs = subNames.filter(s => !triedSubs.includes(s));
        if (remainingSubs.length === 0) {
            console.log(`  ❌ No more subs to try`);
            break;
        }

        // Pick next best sub
        currentSub = await pickBestSubForCaption(caption || '🔥', remainingSubs, imageAnalysis);
        triedSubs.push(currentSub);

        // Generate new title for this sub
        try {
            const retryRulesCtx = await buildSubRulesContext(currentSub, modelId);
            const improved = await improveCaption(
                caption || '🔥',
                currentSub,
                model.bio || '',
                model.persona || '',
                { onlyfans: model.onlyfans_url, privacy: model.privacy_url },
                imageAnalysis,
                retryRulesCtx
            );
            currentTitle = improved.title;
        } catch { /* keep previous title */ }

        const retrySafeSub = currentSub.replace(/_/g, '\\_');
        await sendTelegramMessage(chatId, `🔄 Tentando r/${retrySafeSub}...`);

        result = await submitRedditImagePost(modelId, currentSub, currentTitle, photoUrl, true);
    }

    if (result.success) {
        const successSafeSub = currentSub.replace(/_/g, '\\_');
        await sendTelegramMessage(chatId, `Postado em r/${successSafeSub}!\n\n${result.url || ''}`);

        // Schedule auto-comment to boost visibility
        if (result.url) {
            const { scheduleAutoComment } = await import('./auto-comment');
            scheduleAutoComment(modelId, result.url, currentTitle, model.persona || '');
        }
        await supabase
            .from('subreddits')
            .update({ last_posted_at: new Date().toISOString() })
            .eq('model_id', modelId)
            .eq('name', currentSub);

        // Save to posts table so checkRemovedPosts can track this post
        // and learn from removals (Phase 3)
        await supabase.from('posts').insert({
            model_id: modelId,
            platform: 'reddit',
            subreddit: currentSub,
            title: currentTitle,
            title_style: 'default',
            content: currentTitle,
            photo_url: photoUrl,
            external_url: result.url || null,
            status: 'published',
            published_at: new Date().toISOString(),
        });
    } else {
        const safeError = (result.error || 'Erro desconhecido').replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 200);
        const triedList = triedSubs.map(s => `r/${s}`).join(', ');
        await sendTelegramMessage(chatId, `Erro ao postar (tentei ${triedList}): ${safeError}`);
    }

    await supabase.from('agent_logs').insert({
        model_id: modelId,
        action: 'intelligent_immediate_post',
        details: {
            subreddit: currentSub,
            tried_subs: triedSubs,
            caption: currentTitle,
            success: result.success,
            retries: retryCount,
        },
    });
}

// --- Helpers ---

function timeSince(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return 'agora';
    if (hours < 24) return `${hours}h atrás`;
    const days = Math.floor(hours / 24);
    return `${days}d atrás`;
}
