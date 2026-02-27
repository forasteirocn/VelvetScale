import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { sendDM, checkNewDMs, lookupUserByHandle, hasWriteBudget } from './integrations/twitter';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Twitter Collab Hunter
// Finds creators for S4S partnerships
// Sends DMs and alerts model when they respond
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let collabInterval: ReturnType<typeof setInterval> | null = null;
let dmCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startCollabHunter(): void {
    if (collabInterval) return;

    console.log('🤝 Collab Hunter iniciado (prospecta 1x/dia, checa DMs 2h)');

    // Prospect daily (first run after 30min)
    setTimeout(() => {
        prospectCollabs();
        collabInterval = setInterval(prospectCollabs, 24 * 60 * 60 * 1000); // Daily
    }, 30 * 60 * 1000);

    // Check DM responses every 2h (first run after 15min)
    setTimeout(() => {
        checkDMResponses();
        dmCheckInterval = setInterval(checkDMResponses, 2 * 60 * 60 * 1000); // 2h
    }, 15 * 60 * 1000);
}

export function stopCollabHunter(): void {
    if (collabInterval) {
        clearInterval(collabInterval);
        collabInterval = null;
    }
    if (dmCheckInterval) {
        clearInterval(dmCheckInterval);
        dmCheckInterval = null;
    }
}

// =============================================
// 1. Prospect potential collab partners
// =============================================

async function prospectCollabs(): Promise<void> {
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
            if (!await hasWriteBudget(model.id, 5)) continue; // Need budget for DMs

            await findAndContactPartners(model);
        } catch (err) {
            console.error(`❌ Collab hunter error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

/**
 * Find potential S4S partners and send DMs
 */
async function findAndContactPartners(model: {
    id: string;
    phone: string;
    bio: string;
    persona: string;
    twitter_handle: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get handles we've already contacted
    const { data: existingCollabs } = await supabase
        .from('twitter_collabs')
        .select('target_handle')
        .eq('model_id', model.id);

    const alreadyContacted = new Set((existingCollabs || []).map(c => c.target_handle.toLowerCase()));

    // Find potential partners
    // Strategy: use known handles from the same niche
    // In the future, this can be enhanced with TwitterAPI.io search
    const candidates = await findCandidates(model);

    if (!candidates.length) {
        console.log(`  🤝 No new collab candidates for ${model.id.substring(0, 8)}`);
        return;
    }

    // Filter out already contacted
    const newCandidates = candidates.filter(c => !alreadyContacted.has(c.handle.toLowerCase()));

    // Send DMs to top 2-3 candidates per day
    let sent = 0;
    for (const candidate of newCandidates.slice(0, 3)) {
        if (!await hasWriteBudget(model.id, 1)) break;

        // Look up user ID
        const user = await lookupUserByHandle(model.id, candidate.handle);
        if (!user) {
            console.log(`  ⚠️ Could not find @${candidate.handle}`);
            continue;
        }

        // Generate personalized DM
        const dmText = await generateCollabDM(
            model.persona || '',
            candidate.handle,
            user.description,
            user.followers
        );

        if (!dmText) continue;

        // Send DM
        const result = await sendDM(model.id, user.id, dmText);

        if (result.success) {
            // Save to twitter_collabs
            await supabase.from('twitter_collabs').insert({
                model_id: model.id,
                target_handle: candidate.handle,
                target_user_id: user.id,
                followers_count: user.followers,
                status: 'dm_sent',
                dm_text: dmText,
            });

            sent++;
            console.log(`  📩 S4S DM sent to @${candidate.handle} (${user.followers} followers)`);

            // Wait between DMs
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    if (sent > 0 && model.phone) {
        await sendTelegramMessage(model.phone,
            `🤝 *Collab Hunter:* Enviei ${sent} DM(s) de S4S hoje!\n\nVocê será avisada quando responderem.`
        );
    }
}

/**
 * Find candidate creators for collaboration
 * Currently uses a curated approach — can be enhanced with TwitterAPI.io
 */
async function findCandidates(model: {
    id: string;
    bio: string;
}): Promise<Array<{ handle: string; reason: string }>> {
    // Strategy 1: Ask Claude to suggest handles based on the model's niche
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            system: `You help find Twitter/X creators for potential S4S (shoutout for shoutout) partnerships.
Given a model's bio, suggest 5-10 Twitter handles of real creators in similar niches who might be open to S4S.

CRITERIA:
- Similar niche/aesthetic
- 10k-100k followers (sweet spot — not too big to ignore, not too small)
- Active in the last week
- English-speaking

Respond in JSON format:
[{"handle": "username_without_@", "reason": "brief reason for compatibility"}]

Only respond with the JSON array.`,
            messages: [{
                role: 'user',
                content: `Model bio: "${model.bio}"\n\nSuggest collab partners:`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// =============================================
// 2. Check for DM responses
// =============================================

async function checkDMResponses(): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, twitter_access_token, enabled_platforms')
        .eq('status', 'active')
        .not('twitter_access_token', 'is', null);

    if (!models?.length) return;

    for (const model of models) {
        if (!isPlatformEnabled(model, 'twitter')) continue;
        try {
            await processNewDMs(model.id, model.phone);
        } catch (err) {
            console.error(`⚠️ DM check error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

/**
 * Process new DMs: check if any collab targets responded
 */
async function processNewDMs(modelId: string, chatId: string): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get pending collabs (DM sent, waiting for response)
    const { data: pendingCollabs } = await supabase
        .from('twitter_collabs')
        .select('*')
        .eq('model_id', modelId)
        .eq('status', 'dm_sent');

    if (!pendingCollabs?.length) return;

    const pendingUserIds = new Set(pendingCollabs.map(c => c.target_user_id));

    // Check for new DMs
    const newDMs = await checkNewDMs(modelId);

    for (const dm of newDMs) {
        // Is this from a collab target?
        if (!pendingUserIds.has(dm.senderId)) continue;

        const collab = pendingCollabs.find(c => c.target_user_id === dm.senderId);
        if (!collab) continue;

        // Update collab status
        await supabase
            .from('twitter_collabs')
            .update({
                status: 'responded',
                response_text: dm.text,
                updated_at: new Date().toISOString(),
            })
            .eq('id', collab.id);

        // Generate suggested reply
        const suggestedReply = await generateCollabReply(
            collab.dm_text || '',
            dm.text,
            collab.target_handle
        );

        // Alert model on Telegram
        if (chatId) {
            const safeHandle = collab.target_handle.replace(/_/g, '\\_');
            const safeMsg = dm.text.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 300);
            const safeReply = (suggestedReply || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 300);

            await sendTelegramMessage(chatId,
                `📩 *@${safeHandle}* respondeu sua DM de S4S!\n\n` +
                `*Mensagem:* "${safeMsg}"\n\n` +
                `💡 *Sugestao do Claude:*\n"${safeReply}"\n\n` +
                `→ /aprovar\\_collab\\_${collab.id.substring(0, 8)} para enviar\n` +
                `→ Ou escreva: /collab\\_reply\\_${collab.id.substring(0, 8)} SUA RESPOSTA`
            );
        }

        console.log(`  📩 Collab response from @${collab.target_handle}: "${dm.text.substring(0, 50)}..."`);
    }
}

// =============================================
// 3. Handle collab approval from Telegram
// =============================================

/**
 * Approve and send Claude's suggested reply
 */
export async function approveCollabReply(modelId: string, collabIdPrefix: string): Promise<string> {
    const supabase = getSupabaseAdmin();

    const { data: collabs } = await supabase
        .from('twitter_collabs')
        .select('*')
        .eq('model_id', modelId)
        .eq('status', 'responded')
        .like('id', `${collabIdPrefix}%`);

    if (!collabs?.length) return 'Collab não encontrada ou já respondida.';

    const collab = collabs[0];

    // Regenerate the reply (or use stored one)
    const reply = await generateCollabReply(
        collab.dm_text || '',
        collab.response_text || '',
        collab.target_handle
    );

    if (!reply) return 'Não consegui gerar uma resposta.';

    if (!await hasWriteBudget(modelId, 1)) return 'Budget do Twitter esgotado!';

    const result = await sendDM(modelId, collab.target_user_id, reply);

    if (result.success) {
        await supabase
            .from('twitter_collabs')
            .update({ status: 'agreed', updated_at: new Date().toISOString() })
            .eq('id', collab.id);

        return `✅ Resposta enviada para @${collab.target_handle}!\n\n"${reply}"`;
    }

    return `❌ Erro ao enviar: ${result.error}`;
}

/**
 * Send a custom reply to a collab DM
 */
export async function customCollabReply(
    modelId: string,
    collabIdPrefix: string,
    customText: string
): Promise<string> {
    const supabase = getSupabaseAdmin();

    const { data: collabs } = await supabase
        .from('twitter_collabs')
        .select('*')
        .eq('model_id', modelId)
        .eq('status', 'responded')
        .like('id', `${collabIdPrefix}%`);

    if (!collabs?.length) return 'Collab não encontrada ou já respondida.';

    const collab = collabs[0];

    if (!await hasWriteBudget(modelId, 1)) return 'Budget do Twitter esgotado!';

    const result = await sendDM(modelId, collab.target_user_id, customText);

    if (result.success) {
        await supabase
            .from('twitter_collabs')
            .update({ status: 'agreed', updated_at: new Date().toISOString() })
            .eq('id', collab.id);

        return `✅ Sua resposta foi enviada para @${collab.target_handle}!`;
    }

    return `❌ Erro ao enviar: ${result.error}`;
}

// =============================================
// Claude: Generate DM messages
// =============================================

/**
 * Generate a personalized collab DM
 */
async function generateCollabDM(
    persona: string,
    targetHandle: string,
    targetBio: string,
    targetFollowers: number
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            system: `You write friendly DMs to other content creators proposing S4S (shoutout for shoutout) partnerships.

RULES:
- Be warm, genuine, and personal
- Reference something specific about their profile/bio
- Keep it 2-3 sentences MAX
- Suggest S4S clearly but casually
- NO cringe, NO overly formal language
- Sound like a real person, not a bot
- Persona: ${persona || 'friendly and confident'}

GOOD DM examples:
- "Hey! Love your content, especially the fitness stuff. Would you be down for a S4S sometime? I think our audiences would vibe 💕"
- "Hii! I've been following you for a bit and really love your aesthetic. Wanna do a shoutout exchange? 🤍"

BAD DM examples (never do this):
- "Dear creator, I am reaching out to propose a mutually beneficial partnership..."
- "Hi! I have 50k followers and would like to promote each other!"

Respond with ONLY the DM text.`,
            messages: [{
                role: 'user',
                content: `Target: @${targetHandle}\nBio: "${targetBio}"\nFollowers: ${targetFollowers}\n\nWrite a S4S DM:`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}

/**
 * Generate a reply to a collab response
 */
async function generateCollabReply(
    originalDM: string,
    theirResponse: string,
    theirHandle: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            system: `You are continuing a DM conversation about a S4S (shoutout for shoutout) collab.
Be friendly and move towards scheduling the exchange.
Keep it 1-2 sentences. Be casual and warm.
Respond with ONLY the reply text.`,
            messages: [{
                role: 'user',
                content: `Your original DM: "${originalDM}"\nTheir response: "${theirResponse}"\n\nWrite a reply to @${theirHandle}:`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}
