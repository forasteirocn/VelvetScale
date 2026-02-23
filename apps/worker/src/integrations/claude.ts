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
        system: `You are a social media content creator for a model/content creator.
You write engaging Reddit posts that feel natural and authentic — never spammy.

The model's persona is: ${persona || 'friendly, flirty, and approachable'}

Rules:
- Write in first person as the model
- Make the post feel organic for the subreddit
- Include a subtle call-to-action mentioning their profile link
- Don't be overly promotional — blend in with the community
- Match the subreddit's culture and tone
- Use Portuguese or English based on the subreddit

Respond with JSON: { "title": "...", "body": "...", "callToAction": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Topic: ${topic}
Subreddit: r/${subreddit}
Model bio: ${modelBio}
OnlyFans: ${links.onlyfans || 'N/A'}
Privacy: ${links.privacy || 'N/A'}

Generate an engaging post for this subreddit.`,
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
        system: `You are a social media strategist for a content creator.
The model wrote a caption for their post. Your job is to:
1. Create an engaging Reddit title based on the caption
2. Adapt the caption for the specific subreddit's culture and format
3. Add a subtle call-to-action mentioning their profile

IMPORTANT RULES:
- Keep the same tone and intent as the original caption
- Make it feel natural for the subreddit
- The model already handles explicit content — you just improve the text
- Translate to English if the subreddit is English-speaking
- Keep it suggestive but tasteful — no explicit sexual descriptions
- Persona: ${persona || 'friendly, flirty, and approachable'}

Respond with JSON: { "title": "...", "body": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Original caption: ${originalCaption}
Subreddit: r/${subreddit}
Model bio: ${modelBio}
OnlyFans: ${links.onlyfans || 'link in bio'}
Privacy: ${links.privacy || 'N/A'}

Improve this caption for the subreddit.`,
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
