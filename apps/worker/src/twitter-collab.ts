import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { sendDM, checkNewDMs, lookupUserByHandle, hasWriteBudget, getTwitterClient } from './integrations/twitter';
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

    console.log('🤝 Collab Hunter iniciado (diário 19:15 BRT, checa DMs 2h, executa imediatamente)');

    // Schedule prospecting daily at 19:15 BRT
    scheduleAt1850BRT();

    // Check DM responses immediately, then every 2h
    checkDMResponses();
    dmCheckInterval = setInterval(checkDMResponses, 2 * 60 * 60 * 1000);
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

    // Target: 09:55 BRT today
    const target = new Date(brtNow);
    target.setHours(9, 55, 0, 0);

    // If 09:55 already passed today, schedule for tomorrow
    if (brtNow >= target) {
        target.setDate(target.getDate() + 1);
    }

    // Convert back to local time for setTimeout
    const msUntilTarget = target.getTime() - brtNow.getTime();

    const hours = Math.floor(msUntilTarget / (60 * 60 * 1000));
    const mins = Math.floor((msUntilTarget % (60 * 60 * 1000)) / (60 * 1000));
    console.log(`  ⏰ Próxima busca de collabs em ${hours}h${mins}min (09:55 BRT)`);

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

    if (!models?.length) {
        console.log('🤝 Collab Hunter: Nenhum modelo ativo com twitter_access_token encontrado no banco');
        return;
    }

    console.log(`🤝 Collab Hunter: ${models.length} modelo(s) encontrado(s), verificando elegibilidade...`);

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
 * Find potential S4S partners using REAL Twitter search.
 * No more Claude-invented handles — searches the API directly.
 */
async function suggestCollabPartners(model: {
    id: string;
    phone: string;
    bio: string;
    persona: string;
    twitter_handle: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();
    const auth = await getTwitterClient(model.id);
    if (!auth) {
        console.log(`  ⚠️ No Twitter client for collab search`);
        return;
    }

    const { client } = auth;

    // Get handles we've already suggested
    const { data: existingCollabs } = await supabase
        .from('twitter_collabs')
        .select('target_handle')
        .eq('model_id', model.id);

    const alreadySuggested = new Set((existingCollabs || []).map(c => c.target_handle.toLowerCase()));

    // Search queries targeting the right niches
    const SEARCH_QUERIES = [
        'booty model onlyfans',
        'brunette model fansly',
        'fitness babe content creator',
        'thick model links',
        'curvy creator spicy',
        'latina model 🍑',
        'gym girl onlyfans',
        'natural body creator',
    ];

    // Pick 3-4 random queries to search
    const shuffled = SEARCH_QUERIES.sort(() => Math.random() - 0.5).slice(0, 4);

    const foundProfiles: Array<{ id: string; handle: string; name: string; bio: string; followers: number }> = [];
    const seenIds = new Set<string>();

    for (const query of shuffled) {
        try {
            const searchResult = await client.v2.search(query, {
                max_results: 20,
                'tweet.fields': ['author_id', 'text'],
                expansions: ['author_id'],
                'user.fields': ['public_metrics', 'description', 'username', 'name'],
            });

            if (!searchResult.data?.includes?.users) continue;

            for (const user of searchResult.data.includes.users) {
                const followers = (user as any).public_metrics?.followers_count || 0;

                // Filter: 30K-100K followers, not already suggested, not self
                if (followers < 30000 || followers > 100000) continue;
                if (seenIds.has(user.id)) continue;
                if (alreadySuggested.has(user.username.toLowerCase())) continue;
                if (user.username.toLowerCase() === model.twitter_handle?.toLowerCase()) continue;

                seenIds.add(user.id);
                foundProfiles.push({
                    id: user.id,
                    handle: user.username,
                    name: user.name,
                    bio: ((user as any).description || '').substring(0, 100),
                    followers,
                });
            }
        } catch (err) {
            console.error(`  ⚠️ Search error for "${query}":`, err instanceof Error ? err.message : err);
        }

        // Small delay between searches
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!foundProfiles.length) {
        console.log(`  🤝 Nenhum perfil encontrado nos critérios (30K-100K seguidores)`);
        if (model.phone) {
            await sendTelegramMessage(model.phone,
                `🤝 *Collab Hunter:* Hoje não encontrei perfis novos no range 30K-100K. Amanhã busco de novo!`
            );
        }
        return;
    }

    // Take top 15
    const topProfiles = foundProfiles.slice(0, 15);

    // Generate DMs and save
    const profiles: Array<{ handle: string; name: string; bio: string; followers: number; suggestedDM: string }> = [];

    for (const p of topProfiles) {
        const suggestedDM = await generateCollabDM(
            model.persona || '',
            p.handle,
            p.bio,
            p.followers
        ) || 'Hey! Love your content 💕 Wanna do a S4S?';

        profiles.push({ ...p, suggestedDM });

        // Save as suggested
        await supabase.from('twitter_collabs').insert({
            model_id: model.id,
            target_handle: p.handle,
            target_user_id: p.id,
            followers_count: p.followers,
            status: 'suggested',
            dm_text: suggestedDM,
        });
    }

    // Send suggestions via Telegram
    if (profiles.length > 0 && model.phone) {
        await sendTelegramMessage(model.phone,
            `🤝 *Collab Hunter — ${profiles.length} perfis REAIS encontrados!*\n\n` +
            `Busquei no Twitter perfis do seu nicho com 30K-100K seguidores. Cada um com DM pronta! 👇`
        );

        for (const p of profiles) {
            await sendTelegramMessage(model.phone,
                `🔹 *@${p.handle}* — ${(p.followers / 1000).toFixed(1)}K seguidores\n` +
                `${p.name}\n` +
                `Bio: "${p.bio}"\n\n` +
                `📩 *DM sugerida (copie e cole):*\n\n` +
                `\`${p.suggestedDM}\`\n\n` +
                `_Abra o Twitter → perfil da @${p.handle} → DM → cole!_`
            );

            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.log(`  🤝 Found ${profiles.length} real collab partners via Twitter search`);
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
