import axios from 'axios';

// =============================================
// WhatsApp Business API Integration
// Uses Meta Cloud API
// =============================================

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

/**
 * Send a text message via WhatsApp
 */
export async function sendWhatsAppMessage(to: string, message: string): Promise<boolean> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_TOKEN;

    if (!phoneNumberId || !token) {
        console.error('❌ Missing WhatsApp credentials');
        return false;
    }

    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'text',
                text: { body: message },
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ WhatsApp send error:', errMsg);
        return false;
    }
}

/**
 * Send a message with buttons (interactive)
 */
export async function sendWhatsAppButtons(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>
): Promise<boolean> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_TOKEN;

    if (!phoneNumberId || !token) return false;

    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: {
                        buttons: buttons.map((b) => ({
                            type: 'reply',
                            reply: { id: b.id, title: b.title },
                        })),
                    },
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return true;
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ WhatsApp buttons error:', errMsg);
        return false;
    }
}

/**
 * Mark a message as read
 */
export async function markMessageAsRead(messageId: string): Promise<void> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_TOKEN;

    if (!phoneNumberId || !token) return;

    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch {
        // Silently fail — read receipts are not critical
    }
}
