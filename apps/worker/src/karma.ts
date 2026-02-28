import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Karma Builder
// Makes natural comments + upvotes on popular posts to build karma
// Runs every 45 min, max 15 actions/day (comments + upvotes)
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let karmaInterval: ReturnType<typeof setInterval> | null = null;

export function startKarmaBuilder(): void {
    if (karmaInterval) return;

    console.log('⭐ Karma Builder iniciado (verifica a cada 45 min)');

    // First run after 3 minutes
    setTimeout(() => {
        buildKarma();
        karmaInterval = setInterval(buildKarma, 45 * 60 * 1000); // Every 45 min
    }, 3 * 60 * 1000);
}

export function stopKarmaBuilder(): void {
    if (karmaInterval) {
        clearInterval(karmaInterval);
        karmaInterval = null;
    }
}

/**
 * Main karma-building loop
 */
async function buildKarma(): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get all active models with reddit enabled
    const { data: models } = await supabase
        .from('models')
        .select('id, persona, bio, enabled_platforms')
        .eq('status', 'active');

    if (!models?.length) return;

    for (const model of models) {
        if (!isPlatformEnabled(model, 'reddit')) continue;
        try {
            await buildKarmaForModel(model);
        } catch (err) {
            console.error(`❌ Karma error for ${model.id}:`, err);
        }
    }
}

/**
 * Build karma for a specific model
 */
async function buildKarmaForModel(
    model: { id: string; persona: string; bio: string }
): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Check how many karma actions today (max 15)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const { count } = await supabase
        .from('karma_actions')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', model.id)
        .gte('created_at', todayStart.toISOString());

    const todayCount = count || 0;
    if (todayCount >= 15) {
        console.log(`  ⭐ ${model.id}: Already at 15 karma actions today, skipping`);
        return;
    }

    const remaining = 15 - todayCount;
    const actionsThisRound = Math.min(remaining, 5); // Max 5 per cycle

    // Get model's approved subs (including karma_priority flag)
    const { data: subs } = await supabase
        .from('subreddits')
        .select('name, posting_rules, karma_priority')
        .eq('model_id', model.id)
        .eq('is_approved', true)
        .eq('is_banned', false);

    if (!subs?.length) return;

    // PRIORITY: subs with karma_priority=true (set by Verification Guide)
    // These need active engagement to meet karma requirements for verification
    const prioritySubs = subs.filter(s => s.karma_priority === true);

    // Also check legacy posting_rules flags
    const legacyVerifSubs = subs.filter(s => {
        if (prioritySubs.some(p => p.name === s.name)) return false; // Already in priority
        const rules = s.posting_rules as Record<string, unknown> | null;
        if (!rules) return false;
        return rules.requires_verification || rules.join_requested;
    });

    const allPrioritySubs = [...prioritySubs, ...legacyVerifSubs];
    const regularSubs = subs.filter(s => !allPrioritySubs.some(p => p.name === s.name));

    // Pick targets: 75% priority subs, 25% regular
    let targetSubs: typeof subs = [];

    if (allPrioritySubs.length > 0) {
        // Give 75% of slots to priority subs
        const prioritySlots = Math.max(Math.ceil(actionsThisRound * 0.75), 2);
        const shuffledPriority = [...allPrioritySubs].sort(() => Math.random() - 0.5);
        targetSubs = shuffledPriority.slice(0, Math.min(prioritySlots, shuffledPriority.length));

        // Fill remaining with regular subs
        const remaining = actionsThisRound - targetSubs.length;
        if (remaining > 0 && regularSubs.length > 0) {
            const shuffledReg = [...regularSubs].sort(() => Math.random() - 0.5);
            targetSubs.push(...shuffledReg.slice(0, remaining));
        }

        console.log(`  🔥 Karma Force: ${allPrioritySubs.map(s => s.name).join(', ')} (${prioritySubs.length} priority, ${legacyVerifSubs.length} legacy)`);
    } else {
        // No priority subs — pick random
        const shuffled = [...subs].sort(() => Math.random() - 0.5);
        targetSubs = shuffled.slice(0, actionsThisRound);
    }

    console.log(`  ⭐ Building karma in ${targetSubs.map(s => s.name).join(', ')}`);

    for (const sub of targetSubs) {
        try {
            // Find popular posts in the sub
            const posts = await getTopPostsFromSub(model.id, sub.name);
            if (!posts.length) continue;

            // Pick a random popular post
            const targetPost = posts[Math.floor(Math.random() * posts.length)];

            // Generate a natural comment
            const comment = await generateKarmaComment(
                targetPost.title,
                targetPost.body || '',
                sub.name,
                model.persona || 'friendly and genuine'
            );

            if (!comment) continue;

            // Post the comment via Playwright
            const success = await postKarmaComment(
                model.id,
                targetPost.url,
                comment
            );

            if (success) {
                await supabase.from('karma_actions').insert({
                    model_id: model.id,
                    subreddit: sub.name,
                    post_url: targetPost.url,
                    post_title: targetPost.title,
                    comment_text: comment,
                });

                console.log(`    ✅ Commented in r/${sub.name}: "${comment.substring(0, 50)}..."`);
            }

            // Human-like delay between actions (1-3 minutes)
            const delay = 60000 + Math.random() * 120000;
            await new Promise(r => setTimeout(r, delay));

        } catch (err) {
            console.error(`    ❌ Karma comment error in r/${sub.name}:`, err);
        }
    }
}

/**
 * Get top/hot posts from a subreddit via JSON API
 */
async function getTopPostsFromSub(
    modelId: string,
    subreddit: string
): Promise<Array<{ title: string; body: string; url: string; score: number }>> {
    try {
        const axios = (await import('axios')).default;
        const response = await axios.get(`https://www.reddit.com/r/${subreddit}/hot.json?limit=10`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)',
            },
            timeout: 10000,
        });

        const posts = response.data?.data?.children || [];
        return posts
            .filter((p: any) => p.kind === 't3' && p.data?.title && p.data?.score > 5)
            .map((p: any) => ({
                title: p.data.title,
                body: p.data.selftext || '',
                url: `https://www.reddit.com${p.data.permalink}`,
                score: p.data.score,
            }))
            .slice(0, 5);
    } catch {
        return [];
    }
}

/**
 * Generate a natural, non-promotional comment using Claude
 */
async function generateKarmaComment(
    postTitle: string,
    postBody: string,
    subreddit: string,
    persona: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 150,
            system: `You are a genuine Reddit user browsing r/${subreddit}.
You're commenting on a post because it caught your attention.

CRITICAL RULES:
- Be 100% NATURAL and GENUINE — you are NOT promoting anything
- Comment should be relevant to the POST CONTENT
- Vary your style: sometimes ask questions, sometimes share opinions, sometimes joke
- Keep it short (1-3 sentences, 10-150 characters)
- Write in English
- NEVER mention anything about your own content, profile, or links
- NEVER be creepy or overly sexual, even on NSFW subs
- Sound like a real person, not a bot
- Use emojis sparingly (0-1 max)
- Match the subreddit's casual tone

Examples of GOOD comments:
- "This is beautiful! What camera do you use?"
- "The lighting in this shot is incredible"  
- "Goals honestly 😊"
- "Wow, this made my day better"
- "I love this energy!"

Return ONLY the comment text. If you can't think of something natural, return "SKIP".`,
            messages: [{
                role: 'user',
                content: `Post title: "${postTitle}"
${postBody ? `Post body: "${postBody.substring(0, 300)}"` : ''}

Write a genuine comment.`,
            }],
        });

        const comment = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        if (comment === 'SKIP' || comment.length < 5 || comment.length > 200) return null;
        return comment;
    } catch {
        return null;
    }
}

/**
 * Post a comment on a Reddit post via Playwright
 * Uses old.reddit.com where the DOM is simple standard HTML
 */
async function postKarmaComment(
    modelId: string,
    postUrl: string,
    commentText: string
): Promise<boolean> {
    let context: any = null;
    let page: any = null;
    let browser: any = null;

    try {
        const { chromium } = await import('playwright');
        const path = await import('path');
        const fs = await import('fs');
        const cookiePath = path.join(process.cwd(), '.reddit-sessions', `${modelId}.json`);

        if (!fs.existsSync(cookiePath)) {
            console.log(`    ⚠️ No session for ${modelId}, skipping karma comment`);
            return false;
        }

        browser = await chromium.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
        });

        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
        await context.addCookies(cookies);

        page = await context.newPage();

        // === USE OLD REDDIT — simple DOM, no shadow DOM / web components ===
        // Convert URL: www.reddit.com → old.reddit.com
        const oldRedditUrl = postUrl.replace('www.reddit.com', 'old.reddit.com');
        console.log(`    🔗 Navigating to ${oldRedditUrl.substring(0, 70)}...`);

        await page.goto(oldRedditUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Check if logged in on old Reddit
        const loggedIn = await page.locator('.user a').isVisible({ timeout: 3000 }).catch(() => false);
        if (!loggedIn) {
            console.log(`    ⚠️ Not logged in on old Reddit, skipping`);
            return false;
        }

        // === STEP 1: Upvote the post first (natural behavior) ===
        try {
            const upvoteBtn = page.locator('.thing.link .arrow.up, .thing.link .arrow.upmod').first();
            if (await upvoteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                const isUpvoted = await upvoteBtn.getAttribute('class').catch(() => '');
                if (!isUpvoted?.includes('upmod')) {
                    await upvoteBtn.click();
                    await page.waitForTimeout(1000);
                    console.log(`    👍 Upvoted post`);
                }
            }
        } catch { /* ignore upvote errors */ }

        // === STEP 2: Find the comment textarea ===
        console.log(`    🔍 Looking for comment textarea...`);

        // Old Reddit comment box selectors (standard HTML)
        const commentBoxSelectors = [
            'textarea[name="text"]',                    // Old Reddit main comment box
            '.usertext-edit textarea',                   // Old Reddit comment form
            'form.cloneable textarea',                   // Comment form
            '#comment_reply_form textarea',              // Legacy
            '.commentarea textarea',                     // Comment area
            'textarea.c-form-control',                   // Classic form
        ];

        let commentBox = null;
        for (const sel of commentBoxSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                    commentBox = el;
                    console.log(`    ✅ Found comment box: ${sel}`);
                    break;
                }
            } catch { continue; }
        }

        if (!commentBox) {
            // Scroll down to find it
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.3));
            await page.waitForTimeout(2000);

            for (const sel of commentBoxSelectors) {
                try {
                    const el = page.locator(sel).first();
                    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                        commentBox = el;
                        console.log(`    ✅ Found comment box after scroll: ${sel}`);
                        break;
                    }
                } catch { continue; }
            }
        }

        if (!commentBox) {
            console.log(`    ⚠️ No comment textarea found on old Reddit`);
            return false;
        }

        // === STEP 3: Type the comment ===
        console.log(`    ✍️ Typing comment...`);
        await commentBox.click();
        await page.waitForTimeout(500);
        await commentBox.fill(commentText);
        await page.waitForTimeout(1000);

        // === STEP 4: Submit ===
        console.log(`    📤 Submitting comment...`);

        const submitSelectors = [
            'button[type="submit"]:has-text("save")',    // Old Reddit
            'button[type="submit"]:has-text("comment")', // Variant
            'button.save',                                // Old Reddit classic
            '.usertext-buttons button[type="submit"]',   // usertext form
            'input[type="submit"][value="save"]',        // Legacy input
            'button:has-text("Save")',                    // Generic
            'button:has-text("Comment")',                 // Fallback
        ];

        let commented = false;
        for (const submitSel of submitSelectors) {
            try {
                const submitBtn = page.locator(submitSel).first();
                if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    const isDisabled = await submitBtn.isDisabled().catch(() => false);
                    if (!isDisabled) {
                        await submitBtn.click();
                        commented = true;
                        await page.waitForTimeout(3000);
                        console.log(`    ✅ Karma comment posted!`);
                        break;
                    }
                }
            } catch { continue; }
        }

        if (!commented) {
            console.log(`    ⚠️ Could not find submit button for comment`);
        }

        return commented;
    } catch (err) {
        console.error(`    ❌ Karma comment error:`, err instanceof Error ? err.message : err);
        return false;
    } finally {
        if (page) await page.close().catch(() => { });
        if (context) await context.close().catch(() => { });
        if (browser) await browser.close().catch(() => { });
    }
}
