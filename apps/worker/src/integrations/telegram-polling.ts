import axios from 'axios';
import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage, sendTypingAction, getFileUrl } from './telegram';
import type { TelegramUpdate } from './telegram';
import { commandQueue } from '../queues';

// =============================================
// Telegram Long Polling
// Checks for new messages every 2 seconds
// No webhook URL needed — works from any network
// =============================================

const TELEGRAM_API = 'https://api.telegram.org/bot';

let isPolling = false;
let lastUpdateId = 0;

function getBotUrl(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
    return `${TELEGRAM_API}${token}`;
}

/**
 * Start long polling — called once at startup
 */
export async function startPolling(): Promise<void> {
    if (isPolling) return;
    isPolling = true;

    // First, delete any existing webhook to enable polling mode
    try {
        await axios.post(`${getBotUrl()}/deleteWebhook`);
        console.log('✅ Telegram webhook removed, polling mode active');
    } catch {
        console.log('⚠️ Could not delete webhook, continuing...');
    }

    console.log('🔄 Telegram long polling started');
    pollLoop();
}

/**
 * Stop polling
 */
export function stopPolling(): void {
    isPolling = false;
    console.log('🛑 Telegram polling stopped');
}

/**
 * Main polling loop
 */
async function pollLoop(): Promise<void> {
    while (isPolling) {
        try {
            const response = await axios.get(`${getBotUrl()}/getUpdates`, {
                params: {
                    offset: lastUpdateId + 1,
                    timeout: 30, // Long poll: wait up to 30 seconds for new messages
                    allowed_updates: ['message', 'callback_query'],
                },
                timeout: 35000, // HTTP timeout slightly longer than Telegram timeout
            });

            const updates: TelegramUpdate[] = response.data?.result || [];

            for (const update of updates) {
                lastUpdateId = update.update_id;
                await handleUpdate(update);
            }
        } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            // Don't spam logs on timeout (expected behavior)
            if (!errMsg.includes('timeout')) {
                console.error('❌ Polling error:', errMsg);
            }
            // Wait a bit before retrying on error
            await sleep(2000);
        }
    }
}

/**
 * Handle a single Telegram update
 */
async function handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
        // === Handle /start command ===
        if (update.message?.text === '/start') {
            const chatId = update.message.chat.id;
            console.log(`👋 /start de chat ${chatId}`);
            await sendTelegramMessage(
                chatId,
                `🟣 *Bem-vinda ao VelvetScale!*\n\n` +
                `Seu agente de IA para redes sociais.\n\n` +
                `📝 *Comandos disponíveis:*\n` +
                `• "Poste no Reddit sobre [tema]"\n` +
                `• "Encontrar subreddits"\n` +
                `• "Ver engajamento"\n` +
                `• "Estatísticas"\n\n` +
                `🔐 *Conectar Reddit:*\n` +
                `• /login reddit usuario senha\n\n` +
                `📸 Ou envie uma *foto + legenda* para postar!\n\n` +
                `_Seu Telegram ID: ${chatId}_`
            );
            return;
        }

        // === Handle /login command ===
        if (update.message?.text?.startsWith('/login')) {
            const chatId = update.message.chat.id;
            const telegramId = update.message.from.id.toString();
            const parts = update.message.text.split(' ');

            // Delete the message with credentials for security
            try {
                await axios.post(`${getBotUrl()}/deleteMessage`, {
                    chat_id: chatId,
                    message_id: update.message.message_id,
                });
            } catch {
                // May fail if bot doesn't have delete permission
            }

            if (parts.length < 4) {
                await sendTelegramMessage(chatId, '⚠️ Formato: /login reddit usuario senha');
                return;
            }

            const platform = parts[1].toLowerCase();
            const username = parts[2];
            const password = parts[3];

            if (platform !== 'reddit') {
                await sendTelegramMessage(chatId, '⚠️ Plataformas disponíveis: reddit');
                return;
            }

            // Find model
            const supabase = getSupabaseAdmin();
            const { data: model } = await supabase
                .from('models')
                .select('id, status')
                .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
                .single();

            if (!model) {
                await sendTelegramMessage(chatId, '⚠️ Conta não encontrada.');
                return;
            }

            await sendTelegramMessage(chatId, '🔐 Conectando ao Reddit... Isso pode levar alguns segundos.');
            await sendTypingAction(chatId);

            console.log(`🔐 Login Reddit para modelo ${model.id}: @${username}`);

            // Do the login via Playwright
            const { loginReddit } = await import('./reddit');
            const result = await loginReddit(model.id, username, password, chatId);

            if (result.success) {
                await sendTelegramMessage(
                    chatId,
                    `✅ *Reddit conectado!*\n\nUsuário: ${username}\nSessão salva. Agora você pode postar!`
                );
                console.log(`✅ Reddit login OK: @${username}`);
            } else {
                // Sanitize error for Telegram (special chars break markdown)
                const safeError = (result.error || 'Unknown error').replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 200);
                await sendTelegramMessage(chatId, `❌ Erro no login: ${safeError}`);
                console.log(`❌ Reddit login falhou: ${result.error}`);
            }

            // Log action
            await supabase.from('agent_logs').insert({
                model_id: model.id,
                action: 'reddit_login',
                details: { username, success: result.success, error: result.error },
            });

            return;
        }

        // === Handle text commands ===
        if (update.message?.text) {
            await handleTextMessage(update);
            return;
        }

        // === Handle photo + caption ===
        if (update.message?.photo && update.message.photo.length > 0) {
            await handlePhotoMessage(update);
            return;
        }

    } catch (error) {
        console.error('❌ Error handling update:', error);
    }
}

/**
 * Handle a text message
 */
async function handleTextMessage(update: TelegramUpdate): Promise<void> {
    const msg = update.message!;
    const chatId = msg.chat.id;
    const text = msg.text!.trim();
    const telegramId = msg.from.id.toString();

    console.log(`📩 Msg de ${msg.from.username || telegramId}: "${text}"`);

    await sendTypingAction(chatId);

    // Find model by Telegram ID
    const supabase = getSupabaseAdmin();
    const { data: model } = await supabase
        .from('models')
        .select('id, status')
        .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, `⚠️ Conta não encontrada.\n\nSeu Telegram ID: \`${chatId}\`\nPeça ao admin para cadastrar.`);
        return;
    }

    if (model.status !== 'active') {
        await sendTelegramMessage(chatId, '⏳ Sua conta ainda não foi ativada.');
        return;
    }

    // Save command
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

    // Queue for processing
    await commandQueue.add('process', {
        command_id: command.id,
        model_id: model.id,
        raw_message: text,
        phone: chatId.toString(),
    });

    console.log(`📋 Command ${command.id} queued`);
}

/**
 * Handle a photo message (model sends photo + caption to post)
 */
async function handlePhotoMessage(update: TelegramUpdate): Promise<void> {
    const msg = update.message!;
    const chatId = msg.chat.id;
    const caption = msg.caption || '';
    const telegramId = msg.from.id.toString();

    // Get highest resolution photo
    const bestPhoto = msg.photo![msg.photo!.length - 1];

    console.log(`📸 Foto de ${msg.from.username || telegramId}: "${caption}"`);

    await sendTypingAction(chatId);

    // Find model
    const supabase = getSupabaseAdmin();
    const { data: model } = await supabase
        .from('models')
        .select('*')
        .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, '⚠️ Conta não encontrada.');
        return;
    }

    if (model.status !== 'active') {
        await sendTelegramMessage(chatId, '⏳ Conta não ativada.');
        return;
    }

    // Get photo URL from Telegram
    const photoUrl = await getFileUrl(bestPhoto.file_id);
    if (!photoUrl) {
        await sendTelegramMessage(chatId, '❌ Erro ao processar a foto.');
        return;
    }

    // Get best subreddit
    const { data: subs } = await supabase
        .from('subreddits')
        .select('*')
        .eq('model_id', model.id)
        .eq('is_approved', true)
        .order('last_posted_at', { ascending: true, nullsFirst: true })
        .limit(1);

    const targetSub = subs?.[0]?.name;
    if (!targetSub) {
        await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit configurado. Use "encontrar subreddits" primeiro.');
        return;
    }

    await sendTelegramMessage(chatId, `⏳ Processando... Melhorando legenda e postando em r/${targetSub}`);

    // Improve caption with Claude
    const { improveCaption } = await import('./claude');
    const improved = await improveCaption(
        caption || 'New post 🔥',
        targetSub,
        model.bio || '',
        model.persona || '',
        { onlyfans: model.onlyfans_url, privacy: model.privacy_url }
    );

    // Post to Reddit with image via Playwright
    const { submitRedditImagePost } = await import('./reddit');
    const result = await submitRedditImagePost(
        model.id,
        targetSub,
        improved.title,
        photoUrl,
        true
    );

    if (result.success) {
        await sendTelegramMessage(
            chatId,
            `✅ *Postei em r/${targetSub}!*\n\n📌 ${improved.title}\n🔗 ${result.url}`
        );

        await supabase
            .from('subreddits')
            .update({ last_posted_at: new Date().toISOString() })
            .eq('model_id', model.id)
            .eq('name', targetSub);
    } else {
        await sendTelegramMessage(chatId, `❌ Erro ao postar: ${result.error}`);
    }

    // Log
    await supabase.from('agent_logs').insert({
        model_id: model.id,
        action: 'photo_post',
        details: { subreddit: targetSub, caption: improved.title, success: result.success },
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
