import { getSupabaseAdmin } from '@velvetscale/db';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Karma Builder
// Makes natural comments on popular posts to build karma
// Runs every 2 hours, max 5 comments/day
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let karmaInterval: ReturnType<typeof setInterval> | null = null;

export function startKarmaBuilder(): void {
    if (karmaInterval) return;

    console.log('⭐ Karma Builder iniciado (verifica a cada 2h)');

    // First run after 5 minutes
    setTimeout(() => {
        buildKarma();
        karmaInterval = setInterval(buildKarma, 2 * 60 * 60 * 1000);
    }, 5 * 60 * 1000);
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

    // Get all active models
    const { data: models } = await supabase
        .from('models')
        .select('id, persona, bio')
        .eq('status', 'active');

    if (!models?.length) return;

    for (const model of models) {
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

    // Check how many karma actions today (max 5)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const { count } = await supabase
        .from('karma_actions')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', model.id)
        .gte('created_at', todayStart.toISOString());

    const todayCount = count || 0;
    if (todayCount >= 5) {
        console.log(`  ⭐ ${model.id}: Already at 5 karma actions today, skipping`);
        return;
    }

    const remaining = 5 - todayCount;
    const actionsThisRound = Math.min(remaining, 3); // Max 3 per cycle

    // Get 5 random subs from the model's list
    const { data: subs } = await supabase
        .from('subreddits')
        .select('name')
        .eq('model_id', model.id)
        .eq('is_approved', true)
        .eq('is_banned', false);

    if (!subs?.length) return;

    // Shuffle and pick 3
    const shuffled = [...subs].sort(() => Math.random() - 0.5);
    const targetSubs = shuffled.slice(0, actionsThisRound);

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

            // Human-like delay between actions (3-10 minutes)
            const delay = 180000 + Math.random() * 420000;
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
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4000);

        // === STEP 1: Click on the "Add a comment" placeholder to activate the editor ===
        console.log(`    🔍 Looking for comment area...`);

        const placeholderSelectors = [
            // New Reddit (shreddit)
            'shreddit-comment-share-form [placeholder*="comment" i]',
            'shreddit-comment-share-form [placeholder*="Add" i]',
            'shreddit-comment-share-form div[contenteditable]',
            'shreddit-composer [placeholder]',
            // New Reddit (generic)
            'div[data-test-id="comment-submission-form-richtext"] [placeholder]',
            'div[placeholder*="comment" i]',
            'div[placeholder*="Add" i]',
            'div[placeholder*="thought" i]',
            // Text areas
            'textarea[placeholder*="comment" i]',
            'textarea[placeholder*="Add" i]',
            'textarea[placeholder*="thought" i]',
            'textarea[name="comment"]',
            // Clickable comment area
            'div[role="textbox"]',
            '[contenteditable="true"][role="textbox"]',
        ];

        let editorFound = false;

        for (const sel of placeholderSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                    console.log(`    ✅ Found comment area: ${sel}`);
                    await el.scrollIntoViewIfNeeded().catch(() => { });
                    await page.waitForTimeout(500);
                    await el.click();
                    await page.waitForTimeout(1500);
                    editorFound = true;
                    break;
                }
            } catch { continue; }
        }

        if (!editorFound) {
            // Try scrolling down — comment box might be below the fold
            await page.evaluate(() => window.scrollTo(0, 500));
            await page.waitForTimeout(2000);

            for (const sel of placeholderSelectors) {
                try {
                    const el = page.locator(sel).first();
                    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                        console.log(`    ✅ Found comment area after scroll: ${sel}`);
                        await el.click();
                        await page.waitForTimeout(1500);
                        editorFound = true;
                        break;
                    }
                } catch { continue; }
            }
        }

        if (!editorFound) {
            console.log(`    ⚠️ Could not find comment area on ${postUrl.substring(0, 60)}`);
            return false;
        }

        // === STEP 2: Type the comment (use keyboard, not fill, for contenteditable) ===
        console.log(`    ✍️ Typing comment...`);

        // After clicking, the active editor might be a new element
        const activeEditorSelectors = [
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]:focus',
            'div[contenteditable="true"]',
            'textarea:focus',
            'shreddit-composer div[contenteditable="true"]',
        ];

        let typed = false;
        for (const sel of activeEditorSelectors) {
            try {
                const editor = page.locator(sel).first();
                if (await editor.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await editor.click();
                    await page.waitForTimeout(300);

                    // Use keyboard.type for contenteditable (fill doesn't work)
                    await page.keyboard.type(commentText, { delay: 30 });
                    typed = true;
                    console.log(`    ✅ Comment typed via: ${sel}`);
                    break;
                }
            } catch { continue; }
        }

        // Fallback: try textarea fill
        if (!typed) {
            try {
                const textarea = page.locator('textarea').first();
                if (await textarea.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await textarea.fill(commentText);
                    typed = true;
                    console.log(`    ✅ Comment typed via textarea fill`);
                }
            } catch { /* ignore */ }
        }

        if (!typed) {
            console.log(`    ⚠️ Could not type in comment editor`);
            return false;
        }

        await page.waitForTimeout(1000);

        // === STEP 3: Click submit ===
        console.log(`    📤 Submitting comment...`);

        const submitSelectors = [
            'button:has-text("Comment")',
            'button:has-text("Reply")',
            'button:has-text("Comentar")',
            'button:has-text("Responder")',
            'shreddit-comment-share-form button[type="submit"]',
            'button[type="submit"]',
            // Icon-based submit
            'button[aria-label*="comment" i]',
            'button[aria-label*="submit" i]',
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
                        console.log(`    ✅ Karma comment posted in ${postUrl.substring(0, 60)}`);
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
