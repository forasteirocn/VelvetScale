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

    console.log('🤝 Collab Hunter iniciado (diário 19:00 BRT, checa DMs 2h)');

    // Schedule prospecting daily at 18:50 BRT
    scheduleAt1850BRT();

    // Check DM responses every 2h (first run after 15min)
    setTimeout(() => {
        checkDMResponses();
        dmCheckInterval = setInterval(checkDMResponses, 2 * 60 * 60 * 1000); // 2h
    }, 15 * 60 * 1000);
}

/**
 * Schedule prospectCollabs to run daily at 18:50 BRT (UTC-3)
 */
function scheduleAt1850BRT(): void {
    const now = new Date();

    // BRT = UTC-3
    const brtOffset = -3 * 60; // minutes
    const localOffset = now.getTimezoneOffset(); // minutes from UTC
    const brtNow = new Date(now.getTime() + (localOffset + brtOffset) * 60 * 1000);

    // Target: 19:00 BRT today
    const target = new Date(brtNow);
    target.setHours(19, 0, 0, 0);

    // If 19:00 already passed today, schedule for tomorrow
    if (brtNow >= target) {
        target.setDate(target.getDate() + 1);
    }

    // Convert back to local time for setTimeout
    const msUntilTarget = target.getTime() - brtNow.getTime();

    const hours = Math.floor(msUntilTarget / (60 * 60 * 1000));
    const mins = Math.floor((msUntilTarget % (60 * 60 * 1000)) / (60 * 1000));
    console.log(`  ⏰ Próxima busca de collabs em ${hours}h${mins}min (18:50 BRT)`);

    collabInterval = setTimeout(async () => {
        await prospectCollabs();
        // Reschedule for tomorrow
        scheduleAt1850BRT();
    }, msUntilTarget) as any;
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
// 1. Prospect potential collab partners (suggestion only — no auto-DMs)
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
            await suggestCollabPartners(model);
        } catch (err) {
            console.error(`❌ Collab hunter error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

/**
 * Find potential S4S partners and SUGGEST via Telegram (no auto-DMs).
 * Model sends the DM manually — keeps us policy-compliant.
 */
async function suggestCollabPartners(model: {
    id: string;
    phone: string;
    bio: string;
    persona: string;
    twitter_handle: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get handles we've already suggested
    const { data: existingCollabs } = await supabase
        .from('twitter_collabs')
        .select('target_handle')
        .eq('model_id', model.id);

    const alreadySuggested = new Set((existingCollabs || []).map(c => c.target_handle.toLowerCase()));

    // Find potential partners
    const candidates = await findCandidates(model);

    if (!candidates.length) {
        console.log(`  🤝 No new collab candidates for ${model.id.substring(0, 8)}`);
        return;
    }

    // Filter out already suggested
    const newCandidates = candidates.filter(c => !alreadySuggested.has(c.handle.toLowerCase()));
    if (!newCandidates.length) return;

    // Look up real profiles for top 3 and generate suggested DMs
    const profiles: Array<{ handle: string; reason: string; followers: number; bio: string; suggestedDM: string }> = [];

    for (const candidate of newCandidates.slice(0, 15)) {
        const user = await lookupUserByHandle(model.id, candidate.handle);
        if (!user) continue;

        // Generate suggested DM in the target's language
        const suggestedDM = await generateCollabDM(
            model.persona || '',
            candidate.handle,
            user.description,
            user.followers
        ) || 'Hey! Love your content 💕 Wanna do a S4S?';

        profiles.push({
            handle: candidate.handle,
            reason: candidate.reason,
            followers: user.followers,
            bio: user.description.substring(0, 80),
            suggestedDM,
        });

        // Save as suggested (with DM text for reference)
        await supabase.from('twitter_collabs').insert({
            model_id: model.id,
            target_handle: candidate.handle,
            target_user_id: user.id,
            followers_count: user.followers,
            status: 'suggested',
            dm_text: suggestedDM,
        });
    }

    // Send suggestions via Telegram (one message per profile for easy copy-paste)
    if (profiles.length > 0 && model.phone) {
        // Summary message
        await sendTelegramMessage(model.phone,
            `🤝 *Collab Hunter — ${profiles.length} sugestões de S4S!*\n\n` +
            `Encontrei perfis bons pro seu nicho. Vou mandar cada um com uma DM pronta pra vc copiar e colar! 👇`
        );

        // One message per profile with suggested DM
        for (const p of profiles) {
            await sendTelegramMessage(model.phone,
                `🔹 *@${p.handle}* — ${(p.followers / 1000).toFixed(1)}K seguidores\n` +
                `${p.reason}\n` +
                `Bio: "${p.bio}"\n\n` +
                `📩 *DM sugerida (copie e cole):*\n\n` +
                `\`${p.suggestedDM}\`\n\n` +
                `_Abra o Twitter → perfil da @${p.handle} → DM → cole a mensagem acima!_`
            );

            // Small delay between messages
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    if (profiles.length > 0) {
        console.log(`  🤝 Suggested ${profiles.length} collab partners with DMs via Telegram`);
    }
}

/**
 * Find candidate creators for collaboration.
 * Targets specific niches and geographic audiences.
 */
async function findCandidates(model: {
    id: string;
    bio: string;
}): Promise<Array<{ handle: string; reason: string }>> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            system: `You help find Twitter/X creators for potential S4S (shoutout for shoutout) partnerships.
Given a model's bio, suggest 20 Twitter handles of real creators in similar niches who might be open to S4S.

TARGET NICHES (high conversion for this model):
- Bumbum / booty content creators
- Morenas / brunette models
- Natural body hair / hairy aesthetic
- Anal content creators
- Brazilian-style sensual content

GEOGRAPHIC PREFERENCE (target audiences):
- North American creators (US/Canada)
- European creators (UK, Spain, France, Germany, Italy)
- Japanese creators
- These audiences have the highest conversion rate

CRITERIA:
- Similar niche/aesthetic to the niches above
- 10k-100k followers (sweet spot — not too big to ignore, not too small)
- Active in the last week
- Content creators with OnlyFans/Fansly/similar links
- Preferably NOT Brazilian (we want to reach international audiences)

Respond in JSON format:
[{"handle": "username_without_@", "reason": "brief reason in Portuguese"}]

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
 * Generate a personalized collab DM in the target's language
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
            system: `Você é a Samy, criadora de conteúdo brasileira, escrevendo uma DM para propor S4S (shoutout for shoutout).

PERSONALIDADE:
- Simpática, divertida e direta
- Sarcástica de leve (mas educada — é primeira conversa)
- Confiante sem ser arrogante
- Parece uma pessoa REAL

IDIOMA:
- Analise a bio do target pra detectar o idioma
- Se a bio estiver em inglês → escreva a DM em inglês
- Se a bio estiver em português → escreva em português
- Se a bio estiver em espanhol → escreva em espanhol
- Se a bio estiver em japonês → escreva em inglês (mais seguro)
- Adapte gírias e expressões pro idioma

REGRAS:
- 2-3 frases MAX (mensagem curta = mais chance de resposta)
- Mencione algo ESPECÍFICO da bio ou do conteúdo dela
- Proponha S4S de forma casual e natural
- Use 1 emoji no máximo
- SEM formalidade, SEM cringe
- A DM deve fazer a pessoa QUERER responder

BONS exemplos:
- "Hey! Your booty content is 🔥 would you be down for a S4S? I think our fans would love it"
- "Oii! Amei seu perfil, a gente tem vibes parecidas. Bora fazer um S4S? 💕"

PÉSSIMOS exemplos (NUNCA faça):
- "Dear creator, I am reaching out to propose a partnership..."
- "Oi! Tenho X seguidores e quero propor uma parceria!"

Responda com APENAS o texto da DM.`,
            messages: [{
                role: 'user',
                content: `Target: @${targetHandle}\nBio: "${targetBio}"\nFollowers: ${targetFollowers}\n\nEscreva a DM de S4S:`,
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
