import { Job } from 'bullmq';
import { getSupabaseAdmin } from '@velvetscale/db';
import type { PostJobData } from '@velvetscale/shared';
import { submitRedditPost } from '../../integrations/reddit';
import { sendTelegramMessage } from '../../integrations/telegram';

/**
 * Process a post job (publish to Reddit or Twitter)
 */
export async function processPostJob(job: Job<PostJobData>): Promise<void> {
    const { model_id, platform, content, subreddit } = job.data;
    const supabase = getSupabaseAdmin();

    try {
        // Get model info for notification
        const { data: model } = await supabase
            .from('models')
            .select('phone')
            .eq('id', model_id)
            .single();

        if (platform === 'reddit' && subreddit) {
            const [title, ...bodyParts] = content.split('\n\n');
            const body = bodyParts.join('\n\n') || title;

            const result = await submitRedditPost(model_id, subreddit, title, body);

            if (result.success && model?.phone) {
                await sendTelegramMessage(
                    model.phone,
                    `✅ Post agendado publicado em r/${subreddit}!\n🔗 ${result.url}`
                );
            }

            await supabase.from('agent_logs').insert({
                model_id,
                action: 'post_published',
                platform: 'reddit',
                details: { subreddit, url: result.url, success: result.success },
            });
        }

        // Twitter integration will go here in Phase 2

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Post job error:', errMsg);

        await supabase.from('agent_logs').insert({
            model_id,
            action: 'post_failed',
            platform,
            details: { error: errMsg },
        });
    }
}
