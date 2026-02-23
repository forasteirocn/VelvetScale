import Anthropic from '@anthropic-ai/sdk';
import type { CommandIntent } from '@velvetscale/shared';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// =============================================
// Command Interpreter
// Parses WhatsApp messages into structured intents
// =============================================

interface ParsedCommand {
    intent: CommandIntent;
    params: Record<string, unknown>;
    confidence: number;
}

export async function parseCommand(message: string, modelBio?: string): Promise<ParsedCommand> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You are a command parser for VelvetScale, a social media management platform for content creators.
Parse the user's WhatsApp message into a structured command.

Available intents:
- post_reddit: Create a post on Reddit
- post_twitter: Create a tweet on Twitter/X  
- find_subreddits: Discover relevant subreddits for the model
- check_engagement: Check engagement on recent posts
- schedule_post: Schedule a post for later
- get_stats: Get overall statistics
- unknown: Cannot determine intent

Respond with JSON only: { "intent": "...", "params": {...}, "confidence": 0.0-1.0 }

For post_reddit, extract: { "topic": "...", "subreddit": "r/..." (if specified), "tone": "...", "include_link": true/false }
For find_subreddits, extract: { "niche": "...", "count": N }
For schedule_post, extract: { "platform": "...", "time": "...", "content_hint": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Model bio: ${modelBio || 'No bio available'}\n\nMessage: ${message}`,
            },
        ],
    });

    try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as ParsedCommand;
        }
    } catch {
        // Fall through to default
    }

    return { intent: 'unknown', params: {}, confidence: 0 };
}

// =============================================
// Content Generator
// Generates platform-specific content
// =============================================

interface GeneratedContent {
    title?: string;
    body: string;
    hashtags?: string[];
    callToAction?: string;
}

export async function generateRedditPost(
    topic: string,
    subreddit: string,
    modelBio: string,
    persona: string,
    links: { onlyfans?: string; privacy?: string }
): Promise<GeneratedContent> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a social media strategist for a content creator on Reddit.
You write engaging posts that feel natural, authentic, and never promotional.

The model's persona is: ${persona || 'friendly, flirty, and approachable'}

STRICT RULES:
- Write in first person as the model
- Make the post feel 100% organic for the subreddit
- NEVER include any links (no OnlyFans, no linktree, no URLs of any kind)
- NEVER mention OnlyFans, OF, Fansly, or any paid platform by name
- DO NOT add any call-to-action like "check my profile" or "link in bio"
- The goal is to make people curious enough to click the Reddit profile on their own
- Match the subreddit's culture, tone, and posting style perfectly
- Use English for English-speaking subreddits
- Keep it suggestive but tasteful — Reddit rewards authenticity, not spam
- Write titles that get upvotes: curiosity, humor, or relatability work best

Respond with JSON: { "title": "...", "body": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Topic: ${topic}
Subreddit: r/${subreddit}
Model bio: ${modelBio}

Generate an engaging, organic post for this subreddit. No links, no promotion.`,
            },
        ],
    });

    try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as GeneratedContent;
        }
    } catch {
        // Fall through
    }

    return { body: 'Failed to generate content' };
}

/**
 * Improve a model's caption for a specific subreddit
 * The model provides the original text, Claude adapts it without adding explicit content
 */
export async function improveCaption(
    originalCaption: string,
    subreddit: string,
    modelBio: string,
    persona: string,
    links: { onlyfans?: string; privacy?: string }
): Promise<{ title: string; body: string }> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You are a social media strategist for a content creator on Reddit.
The model wrote a caption for their photo post. Your job is to:
1. Create a catchy Reddit title that gets upvotes
2. Keep it short, natural, and engaging

STRICT RULES:
- NEVER include any links or URLs
- NEVER mention OnlyFans, OF, Fansly, or any paid platform
- NEVER add "check my profile", "link in bio", or any call-to-action
- The title should make people upvote and click the profile naturally
- Translate to English if the subreddit is English-speaking
- Match the subreddit's vibe perfectly
- Keep it short (under 100 characters ideally)
- Use curiosity, humor, or relatability — NOT promotion
- Persona: ${persona || 'friendly, flirty, and approachable'}

Examples of GOOD titles:
- "Finally felt confident enough to share 🙈"
- "Sunday morning vibes ☀️"
- "Do you prefer brunettes or blondes? 😏"
- "First post here, be nice!"

Examples of BAD titles (never do this):
- "Check out my OF link in bio!"
- "New content on my page 🔥"
- "Subscribe for more"

Respond with JSON: { "title": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Original caption: ${originalCaption}
Subreddit: r/${subreddit}
Model bio: ${modelBio}

Create a catchy title for this photo post. No links, no promotion.`,
            },
        ],
    });

    try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as { title: string; body: string };
        }
    } catch {
        // Fall through
    }

    return { title: originalCaption, body: originalCaption };
}

export async function generateTweet(
    topic: string,
    modelBio: string,
    persona: string,
    links: { onlyfans?: string; privacy?: string }
): Promise<GeneratedContent> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You are a social media content creator for a model on Twitter/X.
You write engaging tweets that drive engagement and subtly promote the model's profile.

The model's persona is: ${persona || 'friendly, flirty, and approachable'}

Rules:
- Max 280 characters for the tweet
- Use emojis moderately
- Include relevant hashtags (3-5)
- Make it feel personal and authentic
- Include a link to their profile when appropriate

Respond with JSON: { "body": "...", "hashtags": ["...", "..."], "callToAction": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Topic: ${topic}
Model bio: ${modelBio}
OnlyFans: ${links.onlyfans || 'N/A'}
Privacy: ${links.privacy || 'N/A'}

Generate an engaging tweet.`,
            },
        ],
    });

    try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as GeneratedContent;
        }
    } catch {
        // Fall through
    }

    return { body: 'Failed to generate tweet' };
}

// =============================================
// Subreddit Analyzer
// Finds best subreddits for a model
// =============================================

export interface SubredditSuggestion {
    name: string;
    reason: string;
    nsfw: boolean;
    estimatedReach: string;
    postingFrequency: string;
}

export async function analyzeSubreddits(
    modelBio: string,
    niche?: string
): Promise<SubredditSuggestion[]> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: `You are an expert Reddit strategist for content creators.
Given a model's bio and niche, suggest the best subreddits for promoting their OnlyFans/Privacy profiles.

Consider:
- Subreddit size and engagement levels
- Posting rules and frequency limits
- NSFW vs SFW subs
- Community culture
- Verification requirements

Respond with a JSON array:
[{ "name": "subredditname", "reason": "...", "nsfw": true/false, "estimatedReach": "high/medium/low", "postingFrequency": "daily/weekly/etc" }]

Suggest 5-10 subreddits, ordered by potential impact.`,
        messages: [
            {
                role: 'user',
                content: `Model bio: ${modelBio}\nNiche: ${niche || 'general content creator'}\n\nSuggest the best subreddits.`,
            },
        ],
    });

    try {
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as SubredditSuggestion[];
        }
    } catch {
        // Fall through
    }

    return [];
}

// =============================================
// Smart Sub Picker
// Picks the best subreddit for a specific caption
// =============================================

/**
 * Use Claude to pick the best subreddit for a given caption
 * Returns the name of the most relevant subreddit
 */
export async function pickBestSubForCaption(
    caption: string,
    availableSubs: string[]
): Promise<string> {
    // If only 1 sub, just return it
    if (availableSubs.length <= 1) return availableSubs[0] || '';

    // Pick top 30 random subs to send to Claude (avoid huge prompt)
    const shuffled = [...availableSubs].sort(() => Math.random() - 0.5);
    const candidates = shuffled.slice(0, 30);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            system: `You pick the single best subreddit for a photo post. 
Consider: the caption vibe, the subreddit's theme, and where the post would get the most engagement.
Respond with ONLY the subreddit name, nothing else. No "r/", no explanation.`,
            messages: [
                {
                    role: 'user',
                    content: `Caption: "${caption}"

Available subreddits:
${candidates.map(s => `- ${s}`).join('\n')}

Which ONE subreddit is the best match?`,
                },
            ],
        });

        const chosen = response.content[0].type === 'text'
            ? response.content[0].text.trim().replace(/^r\//, '').replace(/[^a-zA-Z0-9_]/g, '')
            : '';

        // Verify the chosen sub exists in our list
        const match = availableSubs.find(
            s => s.toLowerCase() === chosen.toLowerCase()
        );

        if (match) {
            console.log(`🎯 Claude escolheu: r/${match} para "${caption}"`);
            return match;
        }
    } catch (err) {
        console.error('⚠️ pickBestSub error, using random:', err);
    }

    // Fallback: random
    return shuffled[0];
}

// =============================================
// Comment Analyzer
// Generates natural replies to comments
// =============================================

export async function generateCommentReply(
    comment: string,
    postContext: string,
    persona: string,
    links: { onlyfans?: string; privacy?: string }
): Promise<string> {
    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `You are replying to a Reddit comment as a content creator.
Your persona: ${persona || 'friendly and approachable'}

Rules:
- Be authentic and conversational
- Only mention profile links if directly asked or contextually appropriate
- Never be pushy or spammy
- Match the energy of the comment
- Keep replies concise

Respond with just the reply text, no JSON.`,
        messages: [
            {
                role: 'user',
                content: `Original post context: ${postContext}\nComment: ${comment}\n\nGenerate a natural reply.`,
            },
        ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return text.trim();
}
