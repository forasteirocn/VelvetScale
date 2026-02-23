import { Router, Request, Response } from 'express';
import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTypingAction, getFileUrl } from '../integrations/telegram';
import type { TelegramUpdate } from '../integrations/telegram';
import { commandQueue } from '../queues';

export const webhookRouter = Router();

// =============================================
// Telegram Webhook Handler (POST)
// Receives messages from the Telegram Bot
// =============================================
webhookRouter.post('/telegram', async (req: Request, res: Response) => {
    // Always respond 200 quickly to avoid timeout
    res.sendStatus(200);

    try {
        const update = req.body as TelegramUpdate;

        // Handle text messages
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            const telegramUsername = update.message.from.username || '';
            const telegramId = update.message.from.id.toString();

            // Ignore bot commands like /start for now (handle later)
            if (text === '/start') {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(
                    chatId,
                    `🟣 *Bem-vinda ao VelvetScale!*\n\n` +
                    `Seu agente de IA para redes sociais.\n\n` +
                    `📝 *Comandos disponíveis:*\n` +
                    `• "Poste no Reddit sobre [tema]"\n` +
                    `• "Encontrar subreddits"\n` +
                    `• "Ver engajamento"\n` +
                    `• "Estatísticas"\n\n` +
                    `_Primeiro, peça ao admin para ativar sua conta._`
                );
                return;
            }

            console.log(`📩 Telegram de @${telegramUsername} (${chatId}): ${text}`);

            // Show typing indicator
            await sendTypingAction(chatId);

            // Find model by Telegram chat ID or username
            const supabase = getSupabaseAdmin();
            const { data: model } = await supabase
                .from('models')
                .select('id, status')
                .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
                .single();

            if (!model) {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '⚠️ Conta não encontrada. Peça ao admin para cadastrar seu Telegram ID.');
                return;
            }

            if (model.status !== 'active') {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '⏳ Sua conta ainda não foi ativada. Aguarde a aprovação do admin.');
                return;
            }

            // Save command to DB
            const { data: command } = await supabase
                .from('commands')
                .insert({
                    model_id: model.id,
                    raw_message: text,
                    status: 'received',
                })
                .select('id')
                .single();

            if (!command) return;

            // Add to command processing queue
            await commandQueue.add('process', {
                command_id: command.id,
                model_id: model.id,
                raw_message: text,
                phone: chatId.toString(), // Using chatId as "phone" for Telegram
            });

            console.log(`📋 Command ${command.id} queued for model ${model.id}`);
        }

        // =============================================
        // Handle PHOTO messages (model sends photo + caption)
        // This is the core flow: photo → improve caption → post to Reddit
        // =============================================
        if (update.message?.photo && update.message.photo.length > 0) {
            const chatId = update.message.chat.id;
            const caption = update.message.caption || '';
            const telegramId = update.message.from.id.toString();

            // Get the highest resolution photo (last in array)
            const bestPhoto = update.message.photo[update.message.photo.length - 1];

            console.log(`📸 Photo from ${telegramId} with caption: "${caption}"`);

            await sendTypingAction(chatId);

            // Find model
            const supabase = getSupabaseAdmin();
            const { data: model } = await supabase
                .from('models')
                .select('*')
                .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
                .single();

            if (!model) {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '⚠️ Conta não encontrada.');
                return;
            }

            if (model.status !== 'active') {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '⏳ Conta não ativada.');
                return;
            }

            // Get photo URL from Telegram
            const photoUrl = await getFileUrl(bestPhoto.file_id);
            if (!photoUrl) {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '❌ Erro ao processar a foto. Tente novamente.');
                return;
            }

            // Get the best subreddit to post to
            const { data: subs } = await supabase
                .from('subreddits')
                .select('*')
                .eq('model_id', model.id)
                .eq('is_approved', true)
                .order('last_posted_at', { ascending: true, nullsFirst: true })
                .limit(1);

            const targetSub = subs?.[0]?.name;
            if (!targetSub) {
                const { sendTelegramMessage } = await import('../integrations/telegram');
                await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit configurado. Use "encontrar subreddits" primeiro.');
                return;
            }

            // Improve caption with Claude
            const { improveCaption } = await import('../integrations/claude');
            const improved = await improveCaption(
                caption || 'New post 🔥',
                targetSub,
                model.bio || '',
                model.persona || '',
                { onlyfans: model.onlyfans_url, privacy: model.privacy_url }
            );

            // Post to Reddit with image
            const { submitRedditImagePost } = await import('../integrations/reddit');
            const result = await submitRedditImagePost(
                model.id,
                targetSub,
                improved.title,
                photoUrl,
                true // NSFW
            );

            const { sendTelegramMessage } = await import('../integrations/telegram');
            if (result.success) {
                await sendTelegramMessage(
                    chatId,
                    `✅ *Postei em r/${targetSub}!*\n\n` +
                    `📌 ${improved.title}\n` +
                    `🔗 ${result.url}`
                );

                // Update last posted timestamp
                await supabase
                    .from('subreddits')
                    .update({ last_posted_at: new Date().toISOString() })
                    .eq('model_id', model.id)
                    .eq('name', targetSub);
            } else {
                await sendTelegramMessage(chatId, `❌ Erro ao postar: ${result.error}`);
            }

            // Log the action
            await supabase.from('agent_logs').insert({
                model_id: model.id,
                action: 'photo_post',
                details: { subreddit: targetSub, caption: improved.title, success: result.success },
            });
        }

        // Handle callback queries (button presses)
        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const chatId = update.callback_query.message.chat.id;

            console.log(`🔘 Callback: ${callbackData} from chat ${chatId}`);
            // Handle button callbacks here in the future
        }

    } catch (error) {
        console.error('❌ Telegram webhook error:', error);
    }
});

// =============================================
// Reddit OAuth Callback
// Handles Reddit OAuth2 redirect after model connects their account
// =============================================
webhookRouter.get('/reddit/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state) {
        res.status(400).json({ error: 'Missing code or state parameter' });
        return;
    }

    try {
        const axios = (await import('axios')).default;
        const tokenResponse = await axios.post(
            'https://www.reddit.com/api/v1/access_token',
            `grant_type=authorization_code&code=${code}&redirect_uri=${process.env.NEXT_PUBLIC_APP_URL}/api/auth/reddit/callback`,
            {
                auth: {
                    username: process.env.REDDIT_CLIENT_ID || '',
                    password: process.env.REDDIT_CLIENT_SECRET || '',
                },
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }
        );

        const { access_token, refresh_token, expires_in } = tokenResponse.data;

        const userResponse = await axios.get('https://oauth.reddit.com/api/v1/me', {
            headers: { Authorization: `Bearer ${access_token}` },
        });

        const username = userResponse.data.name;
        const modelId = state as string;

        const supabase = getSupabaseAdmin();
        await supabase.from('social_accounts').upsert(
            {
                model_id: modelId,
                platform: 'reddit',
                username,
                access_token,
                refresh_token,
                token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
                is_active: true,
            },
            { onConflict: 'model_id,platform' }
        );

        res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?reddit=connected`);
    } catch (error) {
        console.error('❌ Reddit OAuth error:', error);
        res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?reddit=error`);
    }
});
