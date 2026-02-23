import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import { submitRedditImagePost } from './integrations/reddit';
import { improveCaption } from './integrations/claude';

// =============================================
// VelvetScale Scheduler
// Runs every 5 minutes, publishes scheduled posts
// =============================================

// Peak posting hours in EST (converted to UTC offsets)
// These are the best times for Reddit engagement
const PEAK_HOURS_EST = [8, 10, 12, 14, 16, 18, 20, 22];

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler — called once at worker startup
 */
export function startScheduler(): void {
    if (schedulerInterval) return;

    console.log('⏰ Scheduler iniciado (verifica a cada 5 min)');

    // Run immediately, then every 5 minutes
    processScheduledPosts();
    schedulerInterval = setInterval(processScheduledPosts, 5 * 60 * 1000);
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('🛑 Scheduler parado');
    }
}

/**
 * Calculate the next posting slots for today and tomorrow
 * Returns an array of timestamps in peak hours
 */
export function getNextPostingSlots(count: number, fromDate?: Date): Date[] {
    const now = fromDate || new Date();
    const slots: Date[] = [];

    // Generate slots for today and tomorrow
    for (let dayOffset = 0; dayOffset <= 1 && slots.length < count; dayOffset++) {
        for (const hour of PEAK_HOURS_EST) {
            if (slots.length >= count) break;

            // Convert EST to UTC (EST = UTC-5)
            const utcHour = hour + 5;
            const slot = new Date(now);
            slot.setDate(slot.getDate() + dayOffset);
            slot.setUTCHours(utcHour, Math.floor(Math.random() * 30), 0, 0); // Random minute 0-29

            // Only include future slots
            if (slot > now) {
                slots.push(slot);
            }
        }
    }

    return slots;
}

/**
 * Schedule a batch of photos for a model
 * Called when model sends photos via Telegram
 */
export async function schedulePhotos(
    modelId: string,
    photos: Array<{ url: string; caption: string }>,
    chatId: number
): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get model's approved subreddits
    const { data: subs } = await supabase
        .from('subreddits')
        .select('*')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .order('last_posted_at', { ascending: true, nullsFirst: true });

    if (!subs?.length) {
        await sendTelegramMessage(chatId,
            '⚠️ Nenhum subreddit configurado!\n\nUse "encontrar subreddits" primeiro.'
        );
        return;
    }

    // Get next available time slots
    const slots = getNextPostingSlots(photos.length);

    if (slots.length === 0) {
        await sendTelegramMessage(chatId, '⚠️ Não há horários disponíveis hoje. Tente amanhã!');
        return;
    }

    // Get model info for Claude
    const { data: model } = await supabase
        .from('models')
        .select('*')
        .eq('id', modelId)
        .single();

    if (!model) return;

    // Schedule each photo
    const scheduled = [];
    for (let i = 0; i < photos.length && i < slots.length; i++) {
        const photo = photos[i];
        const slot = slots[i];

        // Pick the next subreddit (round-robin, respecting cooldowns)
        const targetSub = await pickBestSubreddit(modelId, subs);
        if (!targetSub) continue;

        // Improve caption with Claude
        let improvedTitle = photo.caption;
        try {
            const improved = await improveCaption(
                photo.caption || '🔥',
                targetSub,
                model.bio || '',
                model.persona || '',
                { onlyfans: model.onlyfans_url, privacy: model.privacy_url }
            );
            improvedTitle = improved.title;
        } catch (err) {
            console.error('⚠️ Claude caption error, using original:', err);
        }

        // Insert into scheduled_posts
        const { data: post } = await supabase
            .from('scheduled_posts')
            .insert({
                model_id: modelId,
                photo_url: photo.url,
                original_caption: photo.caption,
                improved_title: improvedTitle,
                target_subreddit: targetSub,
                scheduled_for: slot.toISOString(),
                status: 'ready',
            })
            .select('id')
            .single();

        if (post) {
            scheduled.push({
                subreddit: targetSub,
                time: slot,
                title: improvedTitle,
            });
        }
    }

    // Notify model
    if (scheduled.length > 0) {
        const estOffset = -5;
        let msg = `📅 *${scheduled.length} post(s) agendado(s)!*\n\n`;
        for (const s of scheduled) {
            const estTime = new Date(s.time.getTime() + estOffset * 60 * 60 * 1000);
            const timeStr = estTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            msg += `• ${timeStr} EST → r/${s.subreddit}\n  📌 "${s.title}"\n\n`;
        }
        msg += '_O bot vai postar automaticamente nos horários acima._';
        await sendTelegramMessage(chatId, msg);
    }
}

/**
 * Pick the best subreddit for the next post
 * Respects cooldowns and rotates evenly
 */
async function pickBestSubreddit(
    modelId: string,
    subs: Array<{ name: string; last_posted_at?: string; cooldown_hours?: number }>
): Promise<string | null> {
    const now = new Date();

    for (const sub of subs) {
        const cooldownHours = sub.cooldown_hours || 24;

        if (sub.last_posted_at) {
            const lastPost = new Date(sub.last_posted_at);
            const hoursSince = (now.getTime() - lastPost.getTime()) / (1000 * 60 * 60);
            if (hoursSince < cooldownHours) continue;
        }

        // Check if we already scheduled something for this sub today
        const supabase = getSupabaseAdmin();
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);

        const { count } = await supabase
            .from('scheduled_posts')
            .select('*', { count: 'exact', head: true })
            .eq('model_id', modelId)
            .eq('target_subreddit', sub.name)
            .gte('scheduled_for', todayStart.toISOString())
            .in('status', ['queued', 'ready', 'processing']);

        if ((count || 0) === 0) {
            return sub.name;
        }
    }

    // Fallback: return the sub with oldest post
    return subs[0]?.name || null;
}

/**
 * Main scheduler loop — processes posts that are due
 */
async function processScheduledPosts(): Promise<void> {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Find posts that are ready and due
    const { data: duePosts } = await supabase
        .from('scheduled_posts')
        .select('*, models(phone, bio, persona, onlyfans_url, privacy_url)')
        .eq('status', 'ready')
        .lte('scheduled_for', now)
        .order('scheduled_for', { ascending: true })
        .limit(3); // Process max 3 at a time

    if (!duePosts?.length) return;

    console.log(`📤 ${duePosts.length} post(s) agendado(s) para publicar agora`);

    for (const post of duePosts) {
        try {
            // Mark as processing
            await supabase
                .from('scheduled_posts')
                .update({ status: 'processing' })
                .eq('id', post.id);

            console.log(`📤 Postando em r/${post.target_subreddit}: "${post.improved_title}"`);

            // Post via Playwright
            const result = await submitRedditImagePost(
                post.model_id,
                post.target_subreddit,
                post.improved_title || post.original_caption || '🔥',
                post.photo_url,
                true // NSFW
            );

            if (result.success) {
                // Update scheduled post
                await supabase
                    .from('scheduled_posts')
                    .update({
                        status: 'published',
                        result_url: result.url,
                    })
                    .eq('id', post.id);

                // Update subreddit last_posted_at
                await supabase
                    .from('subreddits')
                    .update({ last_posted_at: new Date().toISOString() })
                    .eq('model_id', post.model_id)
                    .eq('name', post.target_subreddit);

                // Save to posts table
                await supabase.from('posts').insert({
                    model_id: post.model_id,
                    platform: 'reddit',
                    post_type: 'post',
                    content: post.improved_title,
                    media_urls: [post.photo_url],
                    external_url: result.url,
                    subreddit: post.target_subreddit,
                    status: 'published',
                    published_at: new Date().toISOString(),
                });

                // Notify model
                const chatId = (post as any).models?.phone;
                if (chatId) {
                    await sendTelegramMessage(
                        chatId,
                        `✅ *Post agendado publicado!*\n\n📌 ${post.improved_title}\n📍 r/${post.target_subreddit}\n🔗 ${result.url}`
                    );
                }

                console.log(`✅ Publicado em r/${post.target_subreddit}`);

                // Log
                await supabase.from('agent_logs').insert({
                    model_id: post.model_id,
                    action: 'scheduled_post_published',
                    platform: 'reddit',
                    details: {
                        subreddit: post.target_subreddit,
                        title: post.improved_title,
                        url: result.url,
                    },
                });

            } else {
                await supabase
                    .from('scheduled_posts')
                    .update({ status: 'failed', error: result.error })
                    .eq('id', post.id);

                console.log(`❌ Falhou em r/${post.target_subreddit}: ${result.error}`);
            }

            // Wait between posts to not look spammy
            await new Promise(r => setTimeout(r, 3000));

        } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`❌ Scheduler error: ${errMsg}`);

            await supabase
                .from('scheduled_posts')
                .update({ status: 'failed', error: errMsg })
                .eq('id', post.id);
        }
    }
}
