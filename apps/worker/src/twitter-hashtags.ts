import Anthropic from '@anthropic-ai/sdk';

// =============================================
// VelvetScale Smart Hashtag Engine
// Claude generates optimal hashtag mix per niche
// Zero API cost — all local intelligence
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// Hashtag cache to avoid re-generating for same persona
const hashtagCache: Map<string, { tags: string[]; generatedAt: number }> = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Generate smart hashtags for a tweet based on persona, bio, and niche.
 * Mixes high-reach, niche, and trending hashtags.
 * Returns 3-7 hashtags as a string to append.
 */
export async function generateSmartHashtags(
    persona: string,
    bio: string,
    contentType: string = 'photo'
): Promise<string> {
    const cacheKey = `${persona.substring(0, 20)}_${contentType}`;
    const cached = hashtagCache.get(cacheKey);
    if (cached && Date.now() - cached.generatedAt < CACHE_TTL) {
        // Shuffle and pick 3-5 from cache for variety
        const shuffled = cached.tags.sort(() => Math.random() - 0.5);
        return shuffled.slice(0, 3 + Math.floor(Math.random() * 3)).join(' ');
    }

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 200,
            system: `You are a social media hashtag strategist for adult content creators on Twitter/X.

Generate exactly 10 hashtags for this creator, organized by category:
- 3 HIGH REACH hashtags (1M+ posts, broad appeal like #selfie, #model, #beauty)
- 4 NICHE hashtags (100K-1M posts, specific to their content)
- 3 TRENDING/SEASONAL hashtags (timely, current)

Rules:
- All hashtags must be in English
- Include the # symbol
- Keep them relevant to adult/model/creator content
- Mix casual and specific
- NO explicit/banned hashtags

Output ONLY the hashtags, one per line, no categories or explanations.`,
            messages: [{
                role: 'user',
                content: `Creator profile:
Persona: ${persona || 'flirty, confident model'}
Bio: ${bio || 'content creator'}
Content type: ${contentType}

Generate 10 hashtags:`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
        const tags = text
            .split('\n')
            .map(t => t.trim())
            .filter(t => t.startsWith('#') && t.length > 2 && t.length < 30);

        if (tags.length === 0) return '';

        // Cache the full set
        hashtagCache.set(cacheKey, { tags, generatedAt: Date.now() });

        // Return 3-5 random ones for this tweet
        const shuffled = tags.sort(() => Math.random() - 0.5);
        return shuffled.slice(0, 3 + Math.floor(Math.random() * 3)).join(' ');
    } catch (err) {
        console.error('⚠️ Hashtag generation failed:', err instanceof Error ? err.message : err);
        return '';
    }
}
