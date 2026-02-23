import { Job } from 'bullmq';
import { getSupabaseAdmin } from '@velvetscale/db';
import type { CommandJobData } from '@velvetscale/shared';
import { parseCommand, generateRedditPost } from '../../integrations/claude';
import { sendTelegramMessage } from '../../integrations/telegram';
import { submitRedditPost } from '../../integrations/reddit';
import { discoveryQueue } from '../../queues';

/**
 * Process a Telegram command from a model
 */
export async function processCommandJob(job: Job<CommandJobData>): Promise<void> {
    const { command_id, model_id, raw_message, phone: chatId } = job.data;
    const supabase = getSupabaseAdmin();

    try {
        // Update command status
        await supabase
            .from('commands')
            .update({ status: 'processing' })
            .eq('id', command_id);

        // Get model info
        const { data: model } = await supabase
            .from('models')
            .select('*')
            .eq('id', model_id)
            .single();

        if (!model) {
            await sendTelegramMessage(chatId, '❌ Modelo não encontrada. Entre em contato com o suporte.');
            return;
        }

        // Parse the command with Claude
        const parsed = await parseCommand(raw_message, model.bio);

        // Update command with parsed intent
        await supabase
            .from('commands')
            .update({ parsed_intent: parsed.intent, parsed_params: parsed.params })
            .eq('id', command_id);

        // Log the action
        await supabase.from('agent_logs').insert({
            model_id,
            action: 'command_parsed',
            details: { intent: parsed.intent, params: parsed.params, confidence: parsed.confidence },
        });

        // Execute based on intent
        switch (parsed.intent) {
            case 'post_reddit': {
                const params = parsed.params as { topic?: string; subreddit?: string };
                const topic = params.topic || raw_message;

                // Get model's approved subreddits if none specified
                let targetSub = params.subreddit?.replace('r/', '');
                if (!targetSub) {
                    const { data: subs } = await supabase
                        .from('subreddits')
                        .select('*')
                        .eq('model_id', model_id)
                        .eq('is_approved', true)
                        .order('last_posted_at', { ascending: true, nullsFirst: true })
                        .limit(1);

                    targetSub = subs?.[0]?.name;
                }

                if (!targetSub) {
                    await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit configurado. Use "encontrar subreddits" primeiro.');
                    break;
                }

                // Generate content
                const content = await generateRedditPost(
                    topic,
                    targetSub,
                    model.bio || '',
                    model.persona || '',
                    { onlyfans: model.onlyfans_url, privacy: model.privacy_url }
                );

                // Post to Reddit
                const result = await submitRedditPost(
                    model_id,
                    targetSub,
                    content.title || topic,
                    content.body
                );

                if (result.success) {
                    await sendTelegramMessage(
                        chatId,
                        `✅ *Postei em r/${targetSub}!*\n\n📌 ${content.title}\n🔗 ${result.url}`
                    );

                    await supabase
                        .from('subreddits')
                        .update({ last_posted_at: new Date().toISOString() })
                        .eq('model_id', model_id)
                        .eq('name', targetSub);
                } else {
                    await sendTelegramMessage(chatId, `❌ Erro ao postar: ${result.error}`);
                }
                break;
            }

            case 'find_subreddits': {
                const params = parsed.params as { niche?: string };
                await discoveryQueue.add('discover', {
                    model_id,
                    bio: model.bio || '',
                    niche: params.niche,
                });
                await sendTelegramMessage(
                    chatId,
                    '🔍 Buscando os melhores subreddits para você... Vou te avisar quando terminar!'
                );
                break;
            }

            case 'check_engagement': {
                const { data: recentPosts } = await supabase
                    .from('posts')
                    .select('*')
                    .eq('model_id', model_id)
                    .eq('status', 'published')
                    .order('published_at', { ascending: false })
                    .limit(5);

                if (!recentPosts?.length) {
                    await sendTelegramMessage(chatId, '📊 Nenhum post recente encontrado.');
                    break;
                }

                let stats = '📊 *Seus últimos posts:*\n\n';
                for (const post of recentPosts) {
                    const eng = post.engagement || {};
                    stats += `• ${post.subreddit ? `r/${post.subreddit}` : 'Tweet'}: `;
                    stats += `${eng.upvotes || 0}⬆️ ${eng.comments || 0}💬\n`;
                }
                await sendTelegramMessage(chatId, stats);
                break;
            }

            case 'get_stats': {
                const { count: totalPosts } = await supabase
                    .from('posts')
                    .select('*', { count: 'exact', head: true })
                    .eq('model_id', model_id)
                    .eq('status', 'published');

                const { count: totalCommands } = await supabase
                    .from('commands')
                    .select('*', { count: 'exact', head: true })
                    .eq('model_id', model_id);

                await sendTelegramMessage(
                    chatId,
                    `📈 *Suas estatísticas:*\n\n📝 Posts publicados: ${totalPosts || 0}\n💬 Comandos processados: ${totalCommands || 0}`
                );
                break;
            }

            case 'schedule_post': {
                await sendTelegramMessage(chatId, '⏳ Agendamento em desenvolvimento! Em breve disponível.');
                break;
            }

            default: {
                await sendTelegramMessage(
                    chatId,
                    `🤔 Não entendi seu pedido. Tente:\n\n` +
                    `📝 *"Poste no Reddit sobre [tema]"*\n` +
                    `🔍 *"Encontrar subreddits"*\n` +
                    `📊 *"Ver engajamento"*\n` +
                    `📈 *"Estatísticas"*`
                );
            }
        }

        // Mark command as completed
        await supabase
            .from('commands')
            .update({ status: 'completed' })
            .eq('id', command_id);

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Command processing error:', errMsg);

        await supabase
            .from('commands')
            .update({ status: 'failed', error_message: errMsg })
            .eq('id', command_id);

        await sendTelegramMessage(chatId, '❌ Ocorreu um erro ao processar seu comando. Tente novamente.');
    }
}
