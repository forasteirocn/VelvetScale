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
        // === Handle /start or /ajuda command ===
        if (update.message?.text === '/start' || update.message?.text === '/ajuda') {
            const chatId = update.message.chat.id;
            console.log(`👋 ${update.message.text} de chat ${chatId}`);

            // Send in 2 messages to avoid being too long
            await sendTelegramMessage(
                chatId,
                `🟣 *VelvetScale — Como usar*\n\n` +

                `*PASSO 1 — Conectar o Reddit*\n` +
                `Digite exatamente:\n` +
                `/login reddit seuusuario suasenha\n\n` +
                `Exemplo:\n` +
                `/login reddit samyof 123456\n\n` +
                `O que acontece: o bot abre o Chrome, faz login, importa seus subreddits e te avisa quando estiver pronto.\n\n` +

                `*PASSO 2 — Postar uma foto*\n` +
                `Abra sua galeria, escolha uma foto e envie aqui com uma legenda.\n\n` +
                `Exemplo: envie uma selfie e escreva na legenda:\n` +
                `"bom dia gatinhos"\n\n` +
                `O que acontece: a IA melhora sua legenda em inglês, escolhe o melhor subreddit e agenda o post pro próximo horário de pico dos EUA.\n\n` +

                `*PASSO 3 — Acompanhar*\n` +
                `Para ver seus posts agendados, digite:\n` +
                `/fila`
            );

            await sendTelegramMessage(
                chatId,
                `*TODOS OS COMANDOS:*\n\n` +

                `/login reddit usuario senha\n` +
                `→ Conecta o Reddit (só precisa 1 vez)\n\n` +

                `📷 Foto + legenda\n` +
                `→ Agenda post automatico no Reddit\n\n` +

                `📷 Foto + /postar na legenda\n` +
                `→ Posta AGORA no Reddit (sem agendar)\n` +
                `Ex: envie foto com legenda "/postar bom dia"\n\n` +

                `/fila\n` +
                `→ Mostra posts na fila de espera\n\n` +

                `📅 Foto + /piloto na legenda\n` +
                `→ Modo piloto: envie várias fotos e IA cria calendário semanal\n\n` +

                `Estatísticas\n` +
                `→ Mostra quantos posts foram feitos\n\n` +

                `Ver engajamento\n` +
                `→ Mostra upvotes e comentários\n\n` +

                `Encontrar subreddits\n` +
                `→ A IA sugere os melhores subs pro seu perfil\n\n` +

                `Poste no Reddit sobre [tema]\n` +
                `→ Cria e publica um post de texto\n` +
                `Ex: "Poste no Reddit sobre fitness"\n\n` +

                `/ajuda\n` +
                `→ Mostra essa mensagem de novo\n\n` +

                `_ID: ${chatId}_`
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
            const { loginReddit, importSubreddits } = await import('./reddit');
            const result = await loginReddit(model.id, username, password, chatId);

            if (result.success) {
                await sendTelegramMessage(
                    chatId,
                    `✅ *Reddit conectado!*\n\nUsuário: ${username}\n\n⏳ Importando seus subreddits...`
                );
                console.log(`✅ Reddit login OK: @${username}`);

                // Auto-import subreddits
                const importResult = await importSubreddits(model.id);
                if (importResult.imported > 0) {
                    const subList = importResult.subs.slice(0, 10).map(s => `- r/${s.replace(/_/g, '\\_')}`).join('\n');
                    const extra = importResult.subs.length > 10 ? `\n...e mais ${importResult.subs.length - 10}` : '';
                    await sendTelegramMessage(
                        chatId,
                        `${importResult.imported} subreddits importados!\n\n${subList}${extra}\n\nEnvie uma foto pra agendar um post!`
                    );
                } else {
                    await sendTelegramMessage(
                        chatId,
                        '⚠️ Não encontrei subreddits na conta. Use "encontrar subreddits" pra descobrir os melhores!'
                    );
                }
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

        // === Handle /aprovar command ===
        if (update.message?.text?.startsWith('/aprovar')) {
            const chatId = update.message.chat.id;
            const telegramId = update.message.from.id.toString();
            const subArg = update.message.text.replace('/aprovar', '').trim();
            await handleAprovarCommand(chatId, telegramId, subArg);
            return;
        }

        // === Handle /fila command ===
        if (update.message?.text === '/fila') {
            const chatId = update.message.chat.id;
            const telegramId = update.message.from.id.toString();
            console.log(`📋 /fila de chat ${chatId}`);
            await handleFilaCommand(chatId, telegramId);
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
 * Handle a photo message — /postar = immediate, /piloto = batch calendar, otherwise schedules
 */
async function handlePhotoMessage(update: TelegramUpdate): Promise<void> {
    const msg = update.message!;
    const chatId = msg.chat.id;
    const rawCaption = msg.caption || '';
    const telegramId = msg.from.id.toString();
    const isImmediate = rawCaption.toLowerCase().startsWith('/postar');
    const isPiloto = rawCaption.toLowerCase().startsWith('/piloto');
    const caption = isImmediate
        ? rawCaption.replace(/^\/postar\s*/i, '').trim() || '🔥'
        : isPiloto
            ? rawCaption.replace(/^\/piloto\s*/i, '').trim() || '🔥'
            : rawCaption || '🔥';

    // Get highest resolution photo
    const bestPhoto = msg.photo![msg.photo!.length - 1];

    console.log(`📸 Foto de ${msg.from.username || telegramId}: "${caption}" (${isImmediate ? 'IMEDIATO' : isPiloto ? 'PILOTO' : 'agendado'})`);

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

    // Check if model is in batch/piloto mode
    const { isInBatchMode, addPhotoToBatch } = await import('../calendar');

    if (isPiloto || isInBatchMode(model.id)) {
        // === AUTONOMOUS CALENDAR MODE ===
        await addPhotoToBatch(model.id, chatId, photoUrl, caption, bestPhoto.file_id);
    } else if (isImmediate) {
        // === INTELLIGENT IMMEDIATE POST ===
        const { intelligentImmediatePost } = await import('../strategy');
        await intelligentImmediatePost(model.id, photoUrl, caption, chatId);
    } else {
        // === STRATEGIC SCHEDULING (1 foto → 3 subs) ===
        const { analyzeAndSchedule } = await import('../strategy');
        await analyzeAndSchedule(
            model.id,
            [{ url: photoUrl, caption }],
            chatId
        );
    }
}

/**
 * Handle the /fila command — show queued posts
 */
async function handleFilaCommand(chatId: number, telegramId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: model } = await supabase
        .from('models')
        .select('id')
        .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, '⚠️ Conta não encontrada.');
        return;
    }

    const { data: queue } = await supabase
        .from('scheduled_posts')
        .select('*')
        .eq('model_id', model.id)
        .in('status', ['queued', 'ready', 'improving'])
        .order('scheduled_for', { ascending: true })
        .limit(10);

    if (!queue?.length) {
        await sendTelegramMessage(chatId, '📭 Nenhum post na fila. Envie fotos para agendar!');
        return;
    }

    let msg = `📋 *Posts na fila (${queue.length}):*\n\n`;
    for (const post of queue) {
        const time = post.scheduled_for
            ? new Date(post.scheduled_for).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
            : 'pendente';
        msg += `• ${time} EST → r/${post.target_subreddit || '?'}\n`;
        msg += `  📌 "${post.improved_title || post.original_caption || '...'}"\n\n`;
    }

    await sendTelegramMessage(chatId, msg);
}

/**
 * Handle /aprovar command — approve AI-suggested subreddits
 */
async function handleAprovarCommand(chatId: number, telegramId: string, subArg: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: model } = await supabase
        .from('models')
        .select('id')
        .or(`phone.eq.${telegramId},phone.eq.${chatId}`)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, '⚠️ Conta nao encontrada.');
        return;
    }

    if (subArg) {
        // Approve specific sub
        const { data, error } = await supabase
            .from('subreddits')
            .update({ is_approved: true })
            .eq('model_id', model.id)
            .eq('name', subArg)
            .eq('is_approved', false)
            .select('name');

        if (data?.length) {
            const safeName = subArg.replace(/_/g, '\\_');
            await sendTelegramMessage(chatId, `r/${safeName} aprovado!`);
        } else {
            await sendTelegramMessage(chatId, `Sub "${subArg}" nao encontrado ou ja aprovado.`);
        }
    } else {
        // Approve ALL pending subs
        const { data } = await supabase
            .from('subreddits')
            .update({ is_approved: true })
            .eq('model_id', model.id)
            .eq('is_approved', false)
            .eq('suggested_by_ai', true)
            .select('name');

        const count = data?.length || 0;
        if (count > 0) {
            await sendTelegramMessage(chatId, `${count} sub(s) aprovado(s)!`);
        } else {
            await sendTelegramMessage(chatId, 'Nenhum sub pendente de aprovacao.');
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
