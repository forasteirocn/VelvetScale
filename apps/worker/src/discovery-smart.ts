import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Smart Sub Discovery
// Finds new high-potential subreddits daily
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let discoveryInterval: ReturnType<typeof setInterval> | null = null;

export function startSubDiscovery(): void {
    if (discoveryInterval) return;

    console.log('🔍 Sub Discovery iniciado (1x por dia)');

    // First run after 10 minutes
    setTimeout(() => {
        discoverNewSubs();
        // Run once per day (24h)
        discoveryInterval = setInterval(discoverNewSubs, 24 * 60 * 60 * 1000);
    }, 10 * 60 * 1000);
}

export function stopSubDiscovery(): void {
    if (discoveryInterval) {
        clearInterval(discoveryInterval);
        discoveryInterval = null;
    }
}

/**
 * Main discovery loop — runs for all active models
 */
async function discoverNewSubs(): Promise<void> {
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona')
        .eq('status', 'active');

    if (!models?.length) return;

    for (const model of models) {
        try {
            await discoverForModel(model);
        } catch (err) {
            console.error(`❌ Discovery error for ${model.id}:`, err);
        }
    }
}

/**
 * Discover new subs for a specific model
 */
async function discoverForModel(
    model: { id: string; phone: string; bio: string; persona: string }
): Promise<void> {
    const supabase = getSupabaseAdmin();

    // 1. Get model's current subs
    const { data: currentSubs } = await supabase
        .from('subreddits')
        .select('name')
        .eq('model_id', model.id);

    const currentSubNames = new Set((currentSubs || []).map(s => s.name.toLowerCase()));

    // 2. Get top performing subs (to find similar ones)
    const { data: topPerf } = await supabase
        .from('sub_performance')
        .select('subreddit, avg_upvotes')
        .eq('model_id', model.id)
        .order('avg_upvotes', { ascending: false })
        .limit(5);

    const topSubs = topPerf?.map(p => p.subreddit) || [];

    // 3. Ask Claude to suggest new subs based on profile and top performers
    const suggestions = await getAISuggestions(
        model.bio || '',
        model.persona || '',
        Array.from(currentSubNames),
        topSubs
    );

    if (!suggestions.length) return;

    // 4. Verify each suggested sub exists and meets criteria
    const verified: Array<{ name: string; reason: string; members: number }> = [];

    for (const suggestion of suggestions) {
        // Skip if already in the list
        if (currentSubNames.has(suggestion.name.toLowerCase())) continue;

        // Check if sub exists via Reddit JSON API
        const info = await getSubInfo(suggestion.name);
        if (!info) continue;

        // Filter: must have 10k+ members
        if (info.subscribers < 10000) continue;

        verified.push({
            name: suggestion.name,
            reason: suggestion.reason,
            members: info.subscribers,
        });

        if (verified.length >= 5) break;
    }

    if (!verified.length) return;

    // 5. Save as unapproved suggestions
    for (const sub of verified) {
        await supabase.from('subreddits').upsert({
            model_id: model.id,
            name: sub.name,
            is_approved: false,
            nsfw: true,
            suggested_by_ai: true,
            member_count: sub.members,
            rules_summary: sub.reason,
        }, { onConflict: 'model_id,name' });
    }

    // 6. Notify model via Telegram
    if (model.phone) {
        let msg = `🔍 Encontrei ${verified.length} novo(s) sub(s) para voce!\n\n`;
        for (const sub of verified) {
            const safeName = sub.name.replace(/_/g, '\\_');
            const safeReason = sub.reason.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ').substring(0, 100);
            const membersK = Math.round(sub.members / 1000);
            msg += `r/${safeName} (${membersK}k membros)\n${safeReason}\n\n`;
        }
        msg += 'Responda /aprovar para adicionar todos, ou /aprovar NomeSub para aprovar um especifico.';
        await sendTelegramMessage(Number(model.phone), msg);
    }

    console.log(`🔍 ${verified.length} new subs suggested for model ${model.id}`);

    await supabase.from('agent_logs').insert({
        model_id: model.id,
        action: 'sub_discovery',
        details: { found: verified.length, subs: verified.map(s => s.name) },
    });
}

/**
 * Ask Claude to suggest new subreddits
 */
async function getAISuggestions(
    bio: string,
    persona: string,
    currentSubs: string[],
    topPerformers: string[]
): Promise<Array<{ name: string; reason: string }>> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: `You are an expert Reddit marketing strategist for adult content creators.
Suggest NEW subreddits that this model should join for maximum reach.

RULES:
- Only suggest REAL, active subreddits that exist on Reddit
- Focus on NSFW subs with 10k+ members
- Consider the model's bio and persona
- Suggest subs that are DIFFERENT from what she already has
- Think about niches: body types, activities, aesthetics, nationality
- Suggest 8-10 subs

Respond with JSON array: [{"name": "SubName", "reason": "Brief reason in Portuguese"}]`,
            messages: [{
                role: 'user',
                content: `Bio: ${bio}
Persona: ${persona}
Current subs (${currentSubs.length}): ${currentSubs.slice(0, 30).join(', ')}
Top performers: ${topPerformers.join(', ') || 'nenhum dado ainda'}

Suggest 8-10 NEW subs she should join.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        return JSON.parse(jsonMatch[0]);
    } catch {
        return [];
    }
}

/**
 * Get subreddit info via Reddit JSON API
 */
async function getSubInfo(
    subName: string
): Promise<{ subscribers: number; nsfw: boolean; description: string } | null> {
    try {
        const axios = (await import('axios')).default;
        const response = await axios.get(`https://www.reddit.com/r/${subName}/about.json`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)',
            },
            timeout: 10000,
        });

        const data = response.data?.data;
        if (!data) return null;

        return {
            subscribers: data.subscribers || 0,
            nsfw: data.over18 || false,
            description: data.public_description || data.description || '',
        };
    } catch {
        return null;
    }
}
