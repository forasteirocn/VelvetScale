import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { postTweet, postReply, hasWriteBudget, getMonthlyWriteCount } from './integrations/twitter';
import { sendTelegramMessage } from './integrations/telegram';
import { generateSmartHashtags } from './twitter-hashtags';
import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Twitter Content Engine
// Repurposes top Reddit content for Twitter
// Runs every 4 hours
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let twitterInterval: ReturnType<typeof setInterval> | null = null;

export function startTwitterEngine(): void {
    if (twitterInterval) return;

    console.log('🐦 Twitter Content Engine iniciado (4h intervals)');

    // First run after 10 minutes
    setTimeout(() => {
        processTwitterPosts();
        twitterInterval = setInterval(processTwitterPosts, 4 * 60 * 60 * 1000); // 4h
    }, 10 * 60 * 1000);
}

export function stopTwitterEngine(): void {
    if (twitterInterval) {
        clearInterval(twitterInterval);
        twitterInterval = null;
    }
}

// =============================================
// Main loop: find top Reddit content → post to Twitter
// =============================================

async function processTwitterPosts(): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Get active models with Twitter credentials
    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona, twitter_handle, twitter_access_token, enabled_platforms')
        .eq('status', 'active')
        .not('twitter_access_token', 'is', null);

    if (!models?.length) return;

    for (const model of models) {
        if (!isPlatformEnabled(model, 'twitter')) continue;
        try {
            // Check write budget
            if (!await hasWriteBudget(model.id, 3)) { // Need at least 3 (post + 2 replies)
                console.log(`  ⚠️ Twitter budget exhausted for ${model.id.substring(0, 8)}`);
                continue;
            }

            await postBestContent(model);
        } catch (err) {
            console.error(`❌ Twitter engine error for ${model.id.substring(0, 8)}:`, err);
        }
    }
}

/**
 * Find the best performing Reddit post and adapt it for Twitter
 */
async function postBestContent(model: {
    id: string;
    phone: string;
    bio: string;
    persona: string;
    twitter_handle: string;
}): Promise<void> {
    const supabase = getSupabaseAdmin();

    // Find Reddit posts with good performance that haven't been posted to Twitter yet
    const { data: redditPosts } = await supabase
        .from('posts')
        .select('id, title, content, media_urls, photo_url, upvotes, subreddit, external_url')
        .eq('model_id', model.id)
        .eq('platform', 'reddit')
        .eq('status', 'published')
        .gt('upvotes', 5) // Only posts with decent engagement
        .order('upvotes', { ascending: false })
        .limit(20);

    if (!redditPosts?.length) {
        console.log(`  🐦 No good Reddit content to repurpose for ${model.id.substring(0, 8)}`);
        return;
    }

    // Check which posts have already been posted to Twitter
    const redditUrls = redditPosts
        .map(p => p.external_url)
        .filter(Boolean);

    const { data: alreadyPosted } = await supabase
        .from('posts')
        .select('content')
        .eq('model_id', model.id)
        .eq('platform', 'twitter')
        .in('content', redditPosts.map(p => p.title || p.content || ''));

    const postedTitles = new Set((alreadyPosted || []).map(p => p.content));

    // Find the first post that hasn't been tweeted yet
    const candidate = redditPosts.find(p => {
        const title = p.title || p.content || '';
        return !postedTitles.has(title) && title.length > 0;
    });

    if (!candidate) {
        console.log(`  🐦 All good Reddit content already posted to Twitter`);
        return;
    }

    // Adapt the title for Twitter
    const redditTitle = candidate.title || candidate.content || '';
    const twitterCaption = await adaptForTwitter(redditTitle, model.persona || '', model.bio || '');

    if (!twitterCaption) {
        console.log(`  ⚠️ Could not adapt Reddit title for Twitter`);
        return;
    }

    // Get the photo URL
    const photoUrl = candidate.photo_url ||
        (candidate.media_urls && candidate.media_urls[0]) ||
        null;

    // Add smart hashtags
    const hashtags = await generateSmartHashtags(model.persona || '', model.bio || '', 'photo');

    // Add CTA rotation (fan conversion)
    const cta = getRandomCTA();

    // Build final tweet: caption + CTA + hashtags
    let fullTweet = twitterCaption;
    if (cta && fullTweet.length + cta.length + 2 < 250) {
        fullTweet += '\n\n' + cta;
    }
    if (hashtags && fullTweet.length + hashtags.length + 2 < 280) {
        fullTweet += '\n\n' + hashtags;
    }

    // Post the tweet
    console.log(`  🐦 Posting to Twitter: "${fullTweet.substring(0, 50)}..."`);
    const result = await postTweet(model.id, fullTweet, photoUrl || undefined);

    if (result.success) {
        // Save to posts table
        await supabase.from('posts').insert({
            model_id: model.id,
            platform: 'twitter',
            post_type: 'tweet',
            title: fullTweet,
            content: fullTweet,
            media_urls: photoUrl ? [photoUrl] : [],
            external_url: result.url,
            subreddit: null,
            status: 'published',
            published_at: new Date().toISOString(),
        });

        // Post a thread reply for engagement boost
        if (result.tweetId) {
            await postThreadReply(model.id, result.tweetId, model.persona || '');
        }

        // Notify via Telegram
        if (model.phone) {
            const writeCount = await getMonthlyWriteCount(model.id);
            await sendTelegramMessage(
                model.phone,
                `🐦 *Tweet publicado!*\n\n"${fullTweet.substring(0, 100)}"\n\n🔗 ${result.url}\n📊 Budget: ${writeCount}/400 writes este mês`
            );
        }

        // Log
        await supabase.from('agent_logs').insert({
            model_id: model.id,
            action: 'twitter_auto_post',
            platform: 'twitter',
            details: {
                content_type: 'reddit_repurpose',
                tweet_url: result.url,
                source_reddit_url: candidate.external_url,
                original_upvotes: candidate.upvotes,
                adapted_caption: fullTweet,
            },
        });

        console.log(`  ✅ Twitter post done (source: r/${candidate.subreddit} with ${candidate.upvotes} upvotes)`);
    } else {
        console.error(`  ❌ Twitter post failed: ${result.error}`);
    }
}

/**
 * Post a thread reply on own tweet to boost engagement
 */
async function postThreadReply(
    modelId: string,
    tweetId: string,
    persona: string
): Promise<void> {
    if (!await hasWriteBudget(modelId, 1)) return;

    // Wait a bit before replying (looks more natural)
    await new Promise(r => setTimeout(r, 3000));

    try {
        const reply = await generateThreadReply(persona);
        if (reply) {
            await postReply(modelId, tweetId, reply);
            console.log(`  🧵 Thread reply posted: "${reply.substring(0, 40)}..."`);
        }
    } catch {
        // Non-critical, skip
    }
}

// =============================================
// Claude: Adapt content for Twitter
// =============================================

/**
 * Detect if Claude refused to generate content
 */
function isRefusal(text: string): boolean {
    const refusalPhrases = [
        'i can\'t',
        'i cannot',
        'i\'m not able',
        'i am not able',
        'i\'m unable',
        'i won\'t',
        'i will not',
        'i\'d rather not',
        'not comfortable',
        'explicit sexual',
        'sexual content',
        'as an ai',
        'i apologize',
        'i\'m sorry but',
        'content that contains',
        'help create social media content',
        'happy to assist with',
        'happy to help with',
    ];
    const lower = text.toLowerCase();
    return refusalPhrases.some(phrase => lower.includes(phrase));
}

/**
 * Adapt a caption for Twitter — keep in Portuguese BR and style it casually
 */
export async function adaptForTwitter(
    redditTitle: string,
    persona: string,
    bio: string
): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 280,
            system: `Você é uma criadora de conteúdo brasileira adaptando uma legenda para o Twitter/X.
Reescreva a legenda de forma casual e envolvente em Português BR.
Mantenha curto (max 200 chars), tom informal, adicione no máximo 1 emoji.
Se o texto estiver em inglês, traduza para português BR casual.
Saída APENAS o texto adaptado. Sem explicações.`,
            messages: [{
                role: 'user',
                content: `Adapte para o Twitter em PT-BR: "${redditTitle}"`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

        // Safety check: if Claude refused, return null (caller will use original)
        if (!text || isRefusal(text)) {
            console.log('  ⚠️ Claude refused/failed to adapt, using original caption');
            return null;
        }

        return text;
    } catch (err) {
        console.error('⚠️ Twitter adaptation failed:', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Generate a thread reply for engagement (PT-BR)
 */
async function generateThreadReply(persona: string): Promise<string | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 150,
            system: `Gere uma resposta curta ao seu PRÓPRIO tweet, como uma thread.
Mantenha em 1 frase, casual, pessoal. Algo que convide interação.
Persona: ${persona || 'flirty e divertida'}
SEM links, SEM promoção. Apenas um pensamento natural de follow-up.

Bons exemplos:
- "posto mais assim? 👀"
- "a luz tava perfeita dessa vez"
- "oq vcs acham?"
- "tô nervosa de postar essa"

Responda APENAS o texto da reply. Em português BR.`,
            messages: [{ role: 'user', content: 'Escreva uma reply de thread:' }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}

// =============================================
// CTA Rotation (Fan Conversion) — PT-BR
// =============================================

const CTAs = [
    'link na bio 👀',
    '🔗 na bio',
    'tem mais no meu perfil 💕',
    'vcs sabem onde me encontrar 😏',
    'chama na DM 💌',
    'olha minha bio 🔥',
    '', // Sometimes no CTA (feels more natural)
    '',
    '',
];

function getRandomCTA(): string {
    return CTAs[Math.floor(Math.random() * CTAs.length)];
}

// =============================================
// Manual posting command
// =============================================

/**
 * Manual Twitter post triggered by /twitter Telegram command
 */
export async function manualTwitterPost(
    modelId: string,
    chatId: number,
    caption: string,
    photoUrl?: string
): Promise<void> {
    if (!await hasWriteBudget(modelId, 2)) {
        await sendTelegramMessage(chatId, '⚠️ Budget do Twitter esgotado este mês! (400/400 writes)');
        return;
    }

    const supabase = getSupabaseAdmin();

    // Get model persona
    const { data: model } = await supabase
        .from('models')
        .select('persona, bio')
        .eq('id', modelId)
        .single();

    // Adapt caption using Claude (skip for very short captions)
    let tweetText = caption;
    if (caption.length > 20) {
        const adapted = await adaptForTwitter(caption, model?.persona || '', model?.bio || '');
        if (adapted && !isRefusal(adapted)) {
            tweetText = adapted;
        }
        // If Claude refused or failed, use the original caption
    }

    await sendTelegramMessage(chatId, `🐦 Postando no Twitter...\n\n"${tweetText}"`);

    const result = await postTweet(modelId, tweetText, photoUrl);

    if (result.success) {
        // Save to posts
        await supabase.from('posts').insert({
            model_id: modelId,
            platform: 'twitter',
            post_type: 'tweet',
            title: tweetText,
            content: tweetText,
            media_urls: photoUrl ? [photoUrl] : [],
            external_url: result.url,
            status: 'published',
            published_at: new Date().toISOString(),
        });

        const writeCount = await getMonthlyWriteCount(modelId);
        await sendTelegramMessage(chatId,
            `✅ *Tweet publicado!*\n\n🔗 ${result.url}\n📊 Budget: ${writeCount}/400 writes`
        );
    } else {
        await sendTelegramMessage(chatId, `❌ Erro ao postar: ${result.error}`);
    }
}
