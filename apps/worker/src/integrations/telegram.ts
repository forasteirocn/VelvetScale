import axios from 'axios';

// =============================================
// Telegram Bot API Integration
// Replaces WhatsApp — no adult content restrictions
// =============================================

const TELEGRAM_API = 'https://api.telegram.org/bot';

function getBotUrl(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN env var');
    return `${TELEGRAM_API}${token}`;
}

/**
 * Send a text message via Telegram
 */
export async function sendTelegramMessage(chatId: string | number, message: string): Promise<boolean> {
    try {
        await axios.post(`${getBotUrl()}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown',
        });
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Telegram send error:', errMsg);
        return false;
    }
}

/**
 * Send a message with inline keyboard buttons
 */
export async function sendTelegramButtons(
    chatId: string | number,
    text: string,
    buttons: Array<Array<{ text: string; callback_data: string }>>
): Promise<boolean> {
    try {
        await axios.post(`${getBotUrl()}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons,
            },
        });
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Telegram buttons error:', errMsg);
        return false;
    }
}

/**
 * Send a photo with caption
 */
export async function sendTelegramPhoto(
    chatId: string | number,
    photoUrl: string,
    caption?: string
): Promise<boolean> {
    try {
        await axios.post(`${getBotUrl()}/sendPhoto`, {
            chat_id: chatId,
            photo: photoUrl,
            caption,
            parse_mode: 'Markdown',
        });
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Telegram photo error:', errMsg);
        return false;
    }
}

/**
 * Set the webhook URL for receiving messages
 */
export async function setTelegramWebhook(url: string): Promise<boolean> {
    try {
        const res = await axios.post(`${getBotUrl()}/setWebhook`, {
            url,
            allowed_updates: ['message', 'callback_query'],
        });
        console.log('✅ Telegram webhook set:', res.data);
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Telegram webhook error:', errMsg);
        return false;
    }
}

/**
 * Send typing action (shows "typing..." in chat)
 */
export async function sendTypingAction(chatId: string | number): Promise<void> {
    try {
        await axios.post(`${getBotUrl()}/sendChatAction`, {
            chat_id: chatId,
            action: 'typing',
        });
    } catch {
        // Silently fail — typing indicator is not critical
    }
}

/**
 * Get a direct URL for a file sent to the bot (photos, videos, etc.)
 * Telegram stores files on their servers; this gets a temporary download URL
 */
export async function getFileUrl(fileId: string): Promise<string | null> {
    try {
        const res = await axios.post(`${getBotUrl()}/getFile`, {
            file_id: fileId,
        });
        const filePath = res.data?.result?.file_path;
        if (!filePath) return null;

        const token = process.env.TELEGRAM_BOT_TOKEN;
        return `https://api.telegram.org/file/bot${token}/${filePath}`;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Telegram getFile error:', errMsg);
        return null;
    }
}

/**
 * Download a file from Telegram to a local buffer
 */
export async function downloadFile(fileUrl: string): Promise<Buffer | null> {
    try {
        const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ File download error:', errMsg);
        return null;
    }
}

// =============================================
// Telegram Webhook Types
// =============================================

export interface TelegramUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
}

export interface TelegramMessage {
    message_id: number;
    from: TelegramUser;
    chat: {
        id: number;
        type: 'private' | 'group' | 'supergroup' | 'channel';
        first_name?: string;
        username?: string;
    };
    date: number;
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
}

export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message: TelegramMessage;
    data?: string;
}

export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

