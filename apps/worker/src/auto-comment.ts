import { getSupabaseAdmin } from '@velvetscale/db';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// Auto-Comment on Own Posts
// Posts a self-comment 5-10 min after publishing
// to boost visibility in Reddit's algorithm
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Schedule an auto-comment on a post after a delay
 * Posts with at least 1 comment get ~40% more visibility
 */
export function scheduleAutoComment(
    modelId: string,
    postUrl: string,
    title: string,
    persona: string
): void {
    // Random delay between 5-10 minutes
    const delayMs = (5 + Math.random() * 5) * 60 * 1000;
    const delayMin = Math.round(delayMs / 60000);

    console.log(`  💬 Auto-comment scheduled in ${delayMin}min for: ${postUrl}`);

    setTimeout(async () => {
        try {
            await postAutoComment(modelId, postUrl, title, persona);
        } catch (err) {
            console.error('❌ Auto-comment failed:', err instanceof Error ? err.message : err);
        }
    }, delayMs);
}

/**
 * Generate and post a self-comment on own post
 */
async function postAutoComment(
    modelId: string,
    postUrl: string,
    title: string,
    persona: string
): Promise<void> {
    // Generate a natural self-comment
    const comment = await generateSelfComment(title, persona);
    if (!comment) {
        console.log('  💬 Could not generate self-comment, skipping');
        return;
    }

    console.log(`  💬 Posting auto-comment: "${comment.substring(0, 50)}..."`);

    // Post via old Reddit using Playwright
    try {
        const { getModelContext } = await import('./integrations/reddit');
        const ctx = await getModelContext(modelId);
        if (!ctx) {
            console.error('  ❌ No browser context for auto-comment');
            return;
        }

        const page = await ctx.newPage();
        try {
            // Navigate to old Reddit post
            const oldRedditUrl = postUrl
                .replace('www.reddit.com', 'old.reddit.com')
                .replace('new.reddit.com', 'old.reddit.com');

            await page.goto(oldRedditUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            // Find the comment textarea
            const commentBox = page.locator('.usertext-edit textarea').first();
            const hasCommentBox = await commentBox.isVisible().catch(() => false);

            if (!hasCommentBox) {
                console.log('  💬 No comment box found, may need to log in');
                await page.close();
                return;
            }

            // Type the comment
            await commentBox.click();
            await commentBox.fill(comment);
            await page.waitForTimeout(500);

            // Submit
            const submitBtn = page.locator('.usertext-edit button[type="submit"], .usertext-edit .save').first();
            await submitBtn.click();
            await page.waitForTimeout(3000);

            console.log(`  ✅ Auto-comment posted on ${postUrl}`);

            // Log to DB
            const supabase = getSupabaseAdmin();
            await supabase.from('agent_logs').insert({
                model_id: modelId,
                action: 'auto_comment',
                details: {
                    post_url: postUrl,
                    comment: comment.substring(0, 200),
                    success: true,
                },
            });
        } finally {
            await page.close();
        }
    } catch (err) {
        console.error('  ❌ Auto-comment browser error:', err instanceof Error ? err.message : err);
    }
}

/**
 * Generate a natural self-comment using Claude
 * The comment should feel like the OP adding context, not promotion
 */
async function generateSelfComment(
    title: string,
    persona: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 150,
            system: `You are a content creator commenting on your OWN Reddit post.
Write a short, natural comment as the OP (original poster).

RULES:
- Keep it 1-2 sentences MAX
- Feel natural and casual, like you're adding a thought
- NO links, NO promotion, NO "check my profile"
- NO emojis spam (0-1 emoji max)
- Match the persona: ${persona || 'friendly, flirty, and approachable'}
- Common OP self-comments: adding context, asking a question, reacting to the photo
- Write in English

GOOD examples:
- "Took this one right before going out, what do you think?"
- "Should I post more like this?"
- "First time posting here, hope you like it"
- "This was the best photo from that day honestly"

BAD examples (never do this):
- "Check my profile for more!"
- "Link in bio 🔥🔥🔥"
- "Follow me for daily content"

Respond with ONLY the comment text. No JSON, no quotes.`,
            messages: [{
                role: 'user',
                content: `My post title: "${title}"

Write a short, natural OP comment.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        return text || null;
    } catch (err) {
        console.error('⚠️ Self-comment generation failed:', err instanceof Error ? err.message : err);
        return null;
    }
}
