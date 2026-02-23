import { Job } from 'bullmq';
import { getSupabaseAdmin } from '@velvetscale/db';
import type { DiscoveryJobData } from '@velvetscale/shared';
import { analyzeSubreddits } from '../../integrations/claude';
import { searchSubreddits, getSubredditInfo } from '../../integrations/reddit';
import { sendTelegramMessage } from '../../integrations/telegram';

/**
 * Process a subreddit discovery job
 */
export async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
    const { model_id, bio, niche } = job.data;
    const supabase = getSupabaseAdmin();

    try {
        const { data: model } = await supabase
            .from('models')
            .select('phone')
            .eq('id', model_id)
            .single();

        // Step 1: Ask Claude for subreddit suggestions
        const suggestions = await analyzeSubreddits(bio, niche);

        if (!suggestions.length) {
            if (model?.phone) {
                await sendTelegramMessage(model.phone, '❌ Não consegui encontrar subreddits adequados. Tente com um nicho mais específico.');
            }
            return;
        }

        // Step 2: Validate and save each subreddit
        let savedCount = 0;
        for (const suggestion of suggestions) {
            try {
                const info = await getSubredditInfo(model_id, suggestion.name);

                await supabase.from('subreddits').upsert(
                    {
                        model_id,
                        name: suggestion.name,
                        category: niche || 'general',
                        nsfw: info?.nsfw ?? suggestion.nsfw,
                        subscribers: info?.subscribers ?? 0,
                        posting_rules: info ? { rules: info.rules } : null,
                        is_approved: false,
                    },
                    { onConflict: 'model_id,name' }
                );
                savedCount++;
            } catch {
                continue;
            }
        }

        // Step 3: Notify model
        if (model?.phone) {
            let message = `🔍 *Encontrei ${savedCount} subreddits para você!*\n\n`;
            for (const s of suggestions.slice(0, 5)) {
                message += `• *r/${s.name}* — ${s.reason}\n`;
            }
            message += `\nAcesse o dashboard para aprovar os subreddits.`;
            await sendTelegramMessage(model.phone, message);
        }

        await supabase.from('agent_logs').insert({
            model_id,
            action: 'subreddit_discovery',
            details: { suggestions_count: suggestions.length, saved_count: savedCount, niche },
        });

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Discovery job error:', errMsg);

        await supabase.from('agent_logs').insert({
            model_id,
            action: 'discovery_failed',
            details: { error: errMsg },
        });
    }
}
