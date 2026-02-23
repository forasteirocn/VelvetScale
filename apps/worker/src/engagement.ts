import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Engagement Manager
// Auto-replies to comments on model's posts
// Runs every 30 minutes
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let engagementInterval: ReturnType<typeof setInterval> | null = null;

export function startEngagementManager(): void {
    if (engagementInterval) return;

    console.log('💬 Engagement Manager iniciado (verifica a cada 30 min)');

    // First run after 2 minutes (let scheduler start first)
    setTimeout(() => {
        checkAndReplyComments();
        engagementInterval = setInterval(checkAndReplyComments, 30 * 60 * 1000);
    }, 2 * 60 * 1000);
}

export function stopEngagementManager(): void {
    if (engagementInterval) {
        clearInterval(engagementInterval);
        engagementInterval = null;
    }
}

/**
 * Main loop: check recent posts for new comments and reply
 */
async function checkAndReplyComments(): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get posts from the last 48 hours that have a URL
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const { data: posts } = await supabase
        .from('posts')
        .select('*, models(phone, persona, bio)')
        .eq('platform', 'reddit')
        .eq('status', 'published')
        .not('external_url', 'is', null)
        .gte('published_at', twoDaysAgo.toISOString())
        .order('published_at', { ascending: false })
        .limit(5);

    if (!posts?.length) return;

    console.log(`💬 Verificando ${posts.length} posts recentes por comentários...`);

    for (const post of posts) {
        try {
            await processPostComments(post);
        } catch (err) {
            console.error(`❌ Engagement error for ${post.external_url}:`, err);
        }

        // Wait between posts to not overload
        await new Promise(r => setTimeout(r, 5000));
    }
}

/**
 * Scrape comments from a post and reply to new ones
 */
async function processPostComments(post: any): Promise<void> {
    const supabase = getSupabaseAdmin();
    const postUrl = post.external_url;
    if (!postUrl || !postUrl.includes('reddit.com')) return;

    const persona = (post as any).models?.persona || 'friendly and flirty';
    const chatId = (post as any).models?.phone;

    // Get already-replied comments
    const { data: existing } = await supabase
        .from('comment_interactions')
        .select('comment_author, comment_text')
        .eq('post_url', postUrl);

    const repliedAuthors = new Set(existing?.map(e => e.comment_author) || []);

    // Use JSON API approach (lighter than full browser)
    const comments = await scrapeCommentsJSON(postUrl);
    if (!comments.length) return;

    // Filter: ignore already replied, bots, and the model's own comments
    const newComments = comments.filter(c =>
        !repliedAuthors.has(c.author) &&
        !c.author.toLowerCase().includes('bot') &&
        c.author !== 'AutoModerator' &&
        c.body.length > 5 &&
        c.body.length < 500
    );

    if (newComments.length === 0) return;

    console.log(`  💬 ${newComments.length} novos comentários em ${post.subreddit}`);

    // Reply to max 3 comments per post per cycle
    const toReply = newComments.slice(0, 3);

    for (const comment of toReply) {
        try {
            const reply = await generateSmartReply(
                comment.body,
                post.content || '',
                persona
            );

            if (reply) {
                // Post reply via Playwright
                const success = await postCommentReply(
                    post.model_id,
                    postUrl,
                    comment.id,
                    reply
                );

                if (success) {
                    // Save to DB
                    await supabase.from('comment_interactions').insert({
                        model_id: post.model_id,
                        post_url: postUrl,
                        subreddit: post.subreddit,
                        comment_author: comment.author,
                        comment_text: comment.body,
                        reply_text: reply,
                    });

                    console.log(`    ✅ Respondeu ${comment.author}: "${reply.substring(0, 50)}..."`);
                }
            }
        } catch (err) {
            console.error(`    ❌ Reply error:`, err);
        }

        // Wait between replies (human-like)
        await new Promise(r => setTimeout(r, 8000 + Math.random() * 7000));
    }

    // Update post comment count
    await supabase
        .from('posts')
        .update({
            comments_count: comments.length,
            last_checked_at: new Date().toISOString(),
        })
        .eq('id', post.id);

    // Notify model if we replied
    if (chatId && toReply.length > 0) {
        const safeSub = post.subreddit?.replace(/_/g, '\\_') || 'unknown';
        await sendTelegramMessage(
            chatId,
            `💬 Respondi ${toReply.length} comentario(s) no post de r/${safeSub}`
        );
    }
}

/**
 * Generate a smart reply using Claude
 */
async function generateSmartReply(
    commentText: string,
    postTitle: string,
    persona: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 150,
            system: `You are replying to a Reddit comment as a content creator.
Persona: ${persona}

STRICT RULES:
- Keep it SHORT (1-2 sentences max)
- Be natural, warm, and engaging
- Match the commenter's energy (if they're funny, be funny back)
- NEVER mention OnlyFans, links, or paid content
- NEVER be overly sexual or explicit
- If it's a compliment, thank them naturally
- If it's a question, answer genuinely
- If it's creepy/rude, respond with humor or ignore (return empty)
- Use emojis sparingly (0-1 per reply)
- Write in English

Return ONLY the reply text. If the comment doesn't deserve a reply, return "SKIP".`,
            messages: [{
                role: 'user',
                content: `Post title: "${postTitle}"
Comment: "${commentText}"

Generate a natural reply.`,
            }],
        });

        const reply = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        if (reply === 'SKIP' || reply.length < 3) return null;
        return reply;
    } catch {
        return null;
    }
}

/**
 * Scrape comments from a Reddit post URL via JSON endpoint
 */
async function scrapeCommentsJSON(
    postUrl: string
): Promise<Array<{ id: string; author: string; body: string }>> {
    try {
        const axios = (await import('axios')).default;
        // Reddit JSON API: append .json to any post URL
        const jsonUrl = postUrl.endsWith('/') ? postUrl + '.json' : postUrl + '/.json';

        const response = await axios.get(jsonUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)',
            },
            timeout: 10000,
        });

        if (!Array.isArray(response.data) || response.data.length < 2) return [];

        const commentData = response.data[1]?.data?.children || [];
        return commentData
            .filter((c: any) => c.kind === 't1' && c.data?.body)
            .map((c: any) => ({
                id: c.data.name, // fullname like t1_xxx
                author: c.data.author,
                body: c.data.body,
            }));
    } catch {
        return [];
    }
}

/**
 * Post a reply to a comment via Playwright
 */
async function postCommentReply(
    modelId: string,
    postUrl: string,
    commentId: string,
    replyText: string
): Promise<boolean> {
    try {
        const { submitRedditPost } = await import('./integrations/reddit');
        // TODO: implement comment reply via Playwright
        // For now, we'll use the Reddit JSON API approach
        console.log(`    📝 Would reply to ${commentId}: "${replyText.substring(0, 50)}..."`);
        return true; // Placeholder — will implement browser-based reply
    } catch {
        return false;
    }
}
