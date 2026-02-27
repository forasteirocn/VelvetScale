import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { getTwitterClient, hasWriteBudget, trackWriteUsage } from './integrations/twitter';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Twitter Engagement Engine
// Reads mentions → Claude generates replies
// Policy-compliant: only replies when @mentioned
// Runs every 2 hours
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let engagementInterval: ReturnType<typeof setInterval> | null = null;

export function startTwitterEngagement(): void {
    if (engagementInterval) return;

    console.log('💬 Twitter Engagement Engine iniciado (2h intervals)');

    setTimeout(() => {
        processEngagement();
        engagementInterval = setInterval(processEngagement, 2 * 60 * 60 * 1000); // 2h
    }, 15 * 60 * 1000); // First run after 15 min
}

export function stopTwitterEngagement(): void {
    if (engagementInterval) {
        clearInterval(engagementInterval);
        engagementInterval = null;
    }
}

async function processEngagement(): Promise<void> {
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
            await replyToMentions(model);
        } catch (err) {
            console.error(`❌ Twitter engagement error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

async function replyToMentions(model: {
    id: string;
    phone: string;
    persona: string;
    bio: string;
    twitter_handle: string;
}): Promise<void> {
    const auth = await getTwitterClient(model.id);
    if (!auth) return;

    const { client } = auth;

    // Get the authenticated user's ID
    let userId: string;
    try {
        const me = await client.v2.me();
        userId = me.data.id;
    } catch (err) {
        console.error(`  ⚠️ Could not get user ID for ${model.id.substring(0, 8)}`);
        return;
    }

    // Get last processed mention ID from agent_logs
    const supabase = getSupabaseAdmin();
    const { data: lastLog } = await supabase
        .from('agent_logs')
        .select('details')
        .eq('model_id', model.id)
        .eq('action', 'twitter_mention_replied')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    const sinceId = lastLog?.details?.last_mention_id as string | undefined;

    // Fetch recent mentions
    try {
        const mentionsParams: any = {
            max_results: 10,
            'tweet.fields': ['author_id', 'created_at', 'text', 'in_reply_to_user_id'],
            expansions: ['author_id'],
        };
        if (sinceId) mentionsParams.since_id = sinceId;

        const mentions = await client.v2.userMentionTimeline(userId, mentionsParams);

        if (!mentions.data?.data?.length) {
            console.log(`  💬 No new mentions for @${model.twitter_handle || model.id.substring(0, 8)}`);
            return;
        }

        let repliedCount = 0;

        for (const mention of mentions.data.data) {
            // Skip own tweets
            if (mention.author_id === userId) continue;

            // Skip mentions older than 24h
            if (mention.created_at) {
                const age = Date.now() - new Date(mention.created_at).getTime();
                if (age > 24 * 60 * 60 * 1000) continue;
            }

            // Check budget
            if (!await hasWriteBudget(model.id, 1)) {
                console.log(`  ⚠️ Write budget exhausted, stopping engagement`);
                break;
            }

            // Generate reply with Claude
            const reply = await generateMentionReply(
                mention.text,
                model.persona || '',
                model.bio || ''
            );

            if (!reply) continue;

            // Post reply (policy: 1 reply per mention)
            try {
                await client.v2.reply(reply, mention.id);
                await trackWriteUsage(model.id, 'engagement_reply');
                repliedCount++;

                console.log(`  💬 Replied to mention: "${reply.substring(0, 40)}..."`);
            } catch (err) {
                console.error(`  ❌ Reply failed:`, err instanceof Error ? err.message : err);
            }

            // Rate limit: wait between replies
            await new Promise(r => setTimeout(r, 5000));
        }

        // Save last processed mention ID
        if (mentions.data.data.length > 0) {
            const latestId = mentions.data.data[0].id;
            await supabase.from('agent_logs').insert({
                model_id: model.id,
                action: 'twitter_mention_replied',
                details: {
                    last_mention_id: latestId,
                    replied_count: repliedCount,
                    total_mentions: mentions.data.data.length,
                },
            });
        }

        if (repliedCount > 0) {
            console.log(`  ✅ Replied to ${repliedCount} mentions for @${model.twitter_handle || model.id.substring(0, 8)}`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Rate limit or auth errors — skip silently
        if (msg.includes('429') || msg.includes('401')) {
            console.log(`  ⚠️ Rate limited or auth error, will retry next cycle`);
        } else {
            console.error(`  ❌ Mentions fetch error:`, msg);
        }
    }
}

/**
 * Generate a reply to a mention using Claude
 */
async function generateMentionReply(
    mentionText: string,
    persona: string,
    bio: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 150,
            system: `You are replying to someone who mentioned you on Twitter.
Persona: ${persona || 'flirty, fun, approachable'}
Bio: ${bio || 'content creator'}

Rules:
- Keep it SHORT (1 sentence, max 200 chars)
- Be warm, friendly, and on-brand
- Use 1 emoji max
- DO NOT include links or promotions
- DO NOT be generic — reference what they said
- Match the energy of the mention
- If they're being negative/rude, be gracefully dismissive
- If they're complimenting, be thankful and flirty

Output ONLY the reply text.`,
            messages: [{
                role: 'user',
                content: `Reply to this mention: "${mentionText}"`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

        // Safety checks
        if (!text || text.length > 280) return null;

        const refusals = ['i can\'t', 'i cannot', 'as an ai', 'i\'m not able', 'i apologize'];
        if (refusals.some(r => text.toLowerCase().includes(r))) return null;

        return text;
    } catch {
        return null;
    }
}
