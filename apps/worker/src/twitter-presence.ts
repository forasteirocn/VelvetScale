import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { postTweet, hasWriteBudget } from './integrations/twitter';
import { sendTelegramMessage } from './integrations/telegram';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Twitter Smart Presence Engine
// Posts engagement-bait content: polls, questions, threads
// Policy-compliant: all own content, no auto-likes
// Runs every 6 hours
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let presenceInterval: ReturnType<typeof setInterval> | null = null;

export function startTwitterPresence(): void {
    if (presenceInterval) return;

    console.log('✨ Twitter Presence Engine iniciado (6h intervals)');

    setTimeout(() => {
        postPresenceContent();
        presenceInterval = setInterval(postPresenceContent, 6 * 60 * 60 * 1000); // 6h
    }, 30 * 60 * 1000); // First run after 30 min
}

export function stopTwitterPresence(): void {
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
}

const PRESENCE_TYPES = [
    'poll',       // "Rate this look 1-10"
    'question',   // "what should I post next?"
    'hot_take',   // Opinion on something casual
    'behind_scenes', // Casual life update
    'thirst_text', // Flirty text-only tweet
] as const;

type PresenceType = typeof PRESENCE_TYPES[number];

async function postPresenceContent(): Promise<void> {
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
            if (!await hasWriteBudget(model.id, 1)) continue;

            await postForModel(model);
        } catch (err) {
            console.error(`❌ Presence error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

async function postForModel(model: {
    id: string;
    phone: string;
    persona: string;
    bio: string;
    twitter_handle: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Check what type was last posted to avoid repetition
    const { data: lastLogs } = await supabase
        .from('agent_logs')
        .select('details')
        .eq('model_id', model.id)
        .eq('action', 'twitter_presence_post')
        .order('created_at', { ascending: false })
        .limit(3);

    const recentTypes = (lastLogs || [])
        .map(l => l.details?.content_type as string)
        .filter(Boolean);

    // Pick a type that wasn't recently used
    const available = PRESENCE_TYPES.filter(t => !recentTypes.includes(t));
    const contentType: PresenceType = available.length > 0
        ? available[Math.floor(Math.random() * available.length)]
        : PRESENCE_TYPES[Math.floor(Math.random() * PRESENCE_TYPES.length)];

    // Generate content with Claude
    const tweet = await generatePresenceContent(contentType, model.persona, model.bio);
    if (!tweet) return;

    // Post it
    const result = await postTweet(model.id, tweet);

    if (result.success) {
        // Save to posts
        await supabase.from('posts').insert({
            model_id: model.id,
            platform: 'twitter',
            post_type: 'tweet',
            title: tweet,
            content: tweet,
            media_urls: [],
            external_url: result.url,
            status: 'published',
            published_at: new Date().toISOString(),
        });

        // Log
        await supabase.from('agent_logs').insert({
            model_id: model.id,
            action: 'twitter_presence_post',
            platform: 'twitter',
            details: {
                content_type: contentType,
                tweet_url: result.url,
                tweet_text: tweet.substring(0, 100),
            },
        });

        console.log(`  ✨ Presence post (${contentType}): "${tweet.substring(0, 50)}..."`);
    }
}

async function generatePresenceContent(
    type: PresenceType,
    persona: string,
    bio: string
): Promise<string | null> {
    const prompts: Record<PresenceType, string> = {
        poll: `Crie um tweet divertido de enquete/avaliação. Algo como "nota de 1 a 10?" ou "escolham: fotos de manhã ou de noite?" Casual, flirty e interativo. Coloque opções de emoji.`,
        question: `Crie um tweet com pergunta que convide respostas. Algo como "oq devo postar?" ou "selfie de manhã ou de noite?" Genuíno e envolvente.`,
        hot_take: `Crie um tweet casual com opinião sobre o dia a dia. Algo relatável tipo "café > dormir" ou alguma observação engraçada. Leve e com personalidade.`,
        behind_scenes: `Crie um tweet casual de bastidores. Algo como "3h da manhã editando foto 📸" ou "academia e depois selfie, a rotina". Autêntico.`,
        thirst_text: `Crie um tweet flirty só de texto. Algo provocante tipo "tô ousada hoje 👀" ou "posto oq acabei de tirar?" Sugestivo mas não explícito.`,
    };

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            system: `Você é uma criadora de conteúdo brasileira no Twitter/X.
Persona: ${persona || 'flirty, confiante, divertida'}
Bio: ${bio || 'criadora de conteúdo'}

Regras:
- Max 200 caracteres
- 1-2 emojis no máximo
- Casual, tom informal brasileiro
- SEM links, SEM promoções, SEM hashtags
- Natural e autêntico
- Escreva em Português BR
- Saída APENAS o texto do tweet`,
            messages: [{
                role: 'user',
                content: prompts[type],
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        if (!text || text.length > 280) return null;

        const refusals = ['i can\'t', 'i cannot', 'as an ai', 'i apologize', 'não posso'];
        if (refusals.some(r => text.toLowerCase().includes(r))) return null;

        return text;
    } catch {
        return null;
    }
}
