import Anthropic from '@anthropic-ai/sdk';
import type { CommandIntent } from '@velvetscale/shared';
import axios from 'axios';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// =============================================
// Visual Intelligence
// Claude analyzes photos to choose better subs
// =============================================

export interface ImageAnalysis {
    setting: string;       // e.g. "bedroom selfie", "beach", "gym"
    outfit: string;        // e.g. "bikini", "lingerie", "casual"
    mood: string;          // e.g. "flirty", "cute", "bold"
    pose: string;          // e.g. "standing", "squatting", "bending over", "lying down"
    cameraAngle: string;   // e.g. "selfie", "mirror", "from behind", "from above"
    bodyPartFocus: string; // e.g. "breasts", "butt", "face", "full body", "legs"
    bodyFeatures: string[];// e.g. ["tattooed", "curvy", "petite"]
    suggestedNiches: string[]; // e.g. ["alternative", "curvy", "latina"]
    description: string;   // Full description for context
}

/**
 * Download an image and convert to base64 for Claude Vision
 */
async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mediaType: string } | null> {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
        });
        const buffer = Buffer.from(response.data);
        const base64 = buffer.toString('base64');

        // Detect media type
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const mediaType = contentType.includes('png') ? 'image/png'
            : contentType.includes('webp') ? 'image/webp'
                : contentType.includes('gif') ? 'image/gif'
                    : 'image/jpeg';

        return { data: base64, mediaType };
    } catch (err) {
        console.error('⚠️ Failed to fetch image for analysis:', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Analyze an image using Claude Vision
 * Returns structured data about the photo for smart sub/title selection
 */
export async function analyzeImage(imageUrl: string): Promise<ImageAnalysis | null> {
    const maxRetries = 4;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const imageData = await fetchImageAsBase64(imageUrl);
            if (!imageData) return null;

            if (attempt > 1) console.log(`🔄 Tentativa ${attempt}/${maxRetries} de análise de imagem...`);
            console.log('🧠 Analisando foto com Claude Vision...');

            const response = await anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 400,
                system: `You are an expert at analyzing photos for Reddit posting strategy.
Analyze the photo and return a JSON object with PRECISE details.

Focus on:
- Setting (where the photo was taken: bedroom, outdoors, gym, bathroom, etc.)
- Outfit/clothing (lingerie, bikini, dress, nude, topless, jeans, etc.)
- Mood/energy (playful, seductive, confident, casual, artistic, etc.)
- POSE (standing, sitting, lying down, squatting/frog pose, bending over, from behind, frontal, side profile, etc.)
- CAMERA ANGLE (selfie/front-facing, mirror selfie, someone else took it, from above, from below, close-up, full body)
- BODY PART FOCUS — what is the PRIMARY visual focus of the photo? (face, breasts/chest, butt/ass, legs, abs/stomach, full body, back, feet, etc.)
- Notable body features (tattoos, piercings, body type like curvy/slim/athletic/thick, hair color, ethnicity hints)
- What SPECIFIC Reddit niches this would fit (be precise: "curvy" not just "nsfw")

Respond with ONLY valid JSON:
{
  "setting": "brief description of location/background",
  "outfit": "what they're wearing",
  "mood": "the vibe/energy",
  "pose": "specific pose description",
  "cameraAngle": "how the photo was taken",
  "bodyPartFocus": "what body part is the main visual focus",
  "bodyFeatures": ["feature1", "feature2"],
  "suggestedNiches": ["niche1", "niche2", "niche3"],
  "description": "One-sentence summary of the photo"
}`,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: imageData.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                                data: imageData.data,
                            },
                        },
                        {
                            type: 'text',
                            text: 'Analyze this photo for Reddit posting strategy.',
                        },
                    ],
                }],
            });

            const text = response.content[0].type === 'text' ? response.content[0].text : '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const analysis = JSON.parse(jsonMatch[0]) as ImageAnalysis;
                console.log(`  👁️ Foto: ${analysis.description}`);
                console.log(`  🎯 Nichos: ${analysis.suggestedNiches.join(', ')}`);
                return analysis;
            }
        } catch (err) {
            const isOverloaded = err instanceof Error && err.message.includes('529');
            if (isOverloaded && attempt < maxRetries) {
                const wait = attempt * 10000;
                console.log(`⏳ API sobrecarregada, aguardando ${wait / 1000}s antes de tentar novamente...`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            console.error('⚠️ Image analysis failed:', err instanceof Error ? err.message : err);
            return null;
        }
    } // end retry loop
    return null;
}

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
 * Context about subreddit rules for title generation
 */
export interface SubRulesContext {
    titleRules: string[];     // e.g. ["No emojis", "Must include [F] tag"]
    bannedWords: string[];    // e.g. ["onlyfans", "subscribe"]
    otherRules: string[];     // e.g. ["Must be verified to post"]
    topTitles?: string[];     // Top-performing titles from this sub (style reference)
    removalHistory?: Array<{ title: string; reason: string }>; // Past mistakes
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
    links: { onlyfans?: string; privacy?: string },
    imageAnalysis?: ImageAnalysis | null,
    subRules?: SubRulesContext | null
): Promise<{ title: string; body: string }> {
    // Build context from image analysis if available
    const visualContext = imageAnalysis
        ? `\n\nPhoto analysis (what Claude Vision saw):
- Setting: ${imageAnalysis.setting}
- Outfit: ${imageAnalysis.outfit}
- Mood: ${imageAnalysis.mood}
- Features: ${imageAnalysis.bodyFeatures.join(', ')}
- Best niches: ${imageAnalysis.suggestedNiches.join(', ')}
- Description: ${imageAnalysis.description}`
        : '';

    // Build rules context
    const hasEmojiRule = subRules?.titleRules?.some(r =>
        r.toLowerCase().includes('emoji') || r.toLowerCase().includes('no emoji')
    ) || false;

    const rulesSection = subRules && (subRules.titleRules.length > 0 || subRules.bannedWords.length > 0)
        ? `\n\n⚠️ SUBREDDIT-SPECIFIC RULES FOR r/${subreddit} (MUST FOLLOW):
${subRules.titleRules.map(r => `- ${r}`).join('\n')}
${subRules.bannedWords.length > 0 ? `- BANNED WORDS (never use): ${subRules.bannedWords.join(', ')}` : ''}
${subRules.otherRules.map(r => `- ${r}`).join('\n')}`
        : '';

    const topTitlesSection = subRules?.topTitles && subRules.topTitles.length > 0
        ? `\n\nTOP-PERFORMING TITLES in r/${subreddit} right now (mimic this style):
${subRules.topTitles.map(t => `- "${t}"`).join('\n')}`
        : '';

    const removalSection = subRules?.removalHistory && subRules.removalHistory.length > 0
        ? `\n\n🚫 PREVIOUS MISTAKES (these titles were REMOVED from this sub — do NOT repeat):
${subRules.removalHistory.map(r => `- "${r.title}" → Removed because: ${r.reason}`).join('\n')}`
        : '';

    const emojiGuidance = hasEmojiRule
        ? '- DO NOT use any emojis in the title — this sub bans them'
        : '- Use emojis sparingly (0-1 max) ONLY if natural. When in doubt, no emojis.';

    const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `You are a social media strategist for a content creator on Reddit.
The model wrote a caption for their photo post. Your job is to:
1. Create a catchy Reddit title that gets upvotes
2. Keep it short, natural, and engaging
3. ${imageAnalysis ? 'USE the photo analysis to make the title match what\'s actually in the photo' : 'Make the title engaging based on the caption'}
4. STRICTLY follow the subreddit's specific rules below

STRICT RULES:
- NEVER include any links or URLs
- NEVER mention OnlyFans, OF, Fansly, or any paid platform
- NEVER add "check my profile", "link in bio", or any call-to-action
- The title should make people upvote and click the profile naturally
- Translate to English if the subreddit is English-speaking
- Match the subreddit's vibe perfectly
- Keep it short (under 100 characters ideally)
- Use curiosity, humor, or relatability — NOT promotion
${emojiGuidance}
- ${imageAnalysis ? 'Reference the photo content naturally (e.g. if she\'s at the beach, mention it)' : ''}
- Persona: ${persona || 'friendly, flirty, and approachable'}
${rulesSection}${topTitlesSection}${removalSection}

Respond with JSON: { "title": "..." }`,
        messages: [
            {
                role: 'user',
                content: `Original caption: ${originalCaption}
Subreddit: r/${subreddit}
Model bio: ${modelBio}${visualContext}

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
    availableSubs: string[],
    imageAnalysis?: ImageAnalysis | null
): Promise<string> {
    // If only 1 sub, just return it
    if (availableSubs.length <= 1) return availableSubs[0] || '';

    // Pick top 30 random subs to send to Claude (avoid huge prompt)
    const shuffled = [...availableSubs].sort(() => Math.random() - 0.5);
    const candidates = shuffled.slice(0, 30);

    // Build visual context if available
    const visualContext = imageAnalysis
        ? `\n\nPHOTO ANALYSIS (use this to match the sub!):
- Pose: ${imageAnalysis.pose || 'unknown'}
- Camera angle: ${imageAnalysis.cameraAngle || 'unknown'}
- Body part focus: ${imageAnalysis.bodyPartFocus || 'unknown'}
- Setting: ${imageAnalysis.setting}
- Outfit: ${imageAnalysis.outfit}
- Mood: ${imageAnalysis.mood}
- Features: ${imageAnalysis.bodyFeatures.join(', ')}
- Best niches: ${imageAnalysis.suggestedNiches.join(', ')}
- Description: ${imageAnalysis.description}`
        : '';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 100,
            system: `You pick the single best subreddit for a photo post.

CRITICAL RULES — read carefully:
1. The PHOTO ANALYSIS tells you exactly what's in the photo. USE IT.
2. The body part focus is the MOST IMPORTANT factor.
3. The pose determines which specific subs fit.
4. DO NOT choose a sub unless the photo's content EXACTLY matches the sub's niche.

COMMON SUB NICHES (know these!):
- FrogButt = ONLY squatting/frog pose showing butt. NOT for any butt photo.
- assholegonewild = close-up butt/rear photos
- boobs/tits subs = breasts must be the PRIMARY focus
- curvy = curvy/thick body type, any pose
- latinas/braziliangirls = ethnicity-based, any content
- selfie/faces = face must be visible and prominent
- bikini/lingerie = specific clothing type
- tattoo/alt subs = must have visible tattoos/alt style
- gonewild = general NSFW, any content fits
- thick/pawg = thick body type, often butt-focused
- yoga/fit = athletic/fit body, exercise poses

MATCHING EXAMPLES:
✅ Photo: butt focus + squatting pose → FrogButt
✅ Photo: butt focus + standing/bending → assholegonewild, pawg, thick
✅ Photo: breast focus + frontal → boobs, tits, busty
✅ Photo: full body + curvy + latina → latinas, curvy
❌ Photo: breast focus → FrogButt (WRONG! FrogButt is for squatting butts only)
❌ Photo: face selfie close-up → thick (WRONG! thick is about body)

Respond with ONLY the subreddit name, nothing else. No "r/", no explanation.`,
            messages: [
                {
                    role: 'user',
                    content: `Caption: "${caption}"${visualContext}

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
            console.log(`🎯 Claude escolheu: r/${match} para "${caption}"${imageAnalysis ? ' (com visão)' : ''}`);
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

// =============================================
// A/B Title Testing
// Generate multiple title variations to test
// =============================================

export interface TitleVariant {
    title: string;
    style: 'curiosity' | 'humor' | 'direct' | 'question' | 'emotional';
    confidence: number; // 0-100
}

/**
 * Generate 3 title variations for A/B testing
 * Each uses a different psychological angle
 */
export async function generateABTitles(
    caption: string,
    subreddit: string,
    modelBio: string,
    persona: string,
    imageAnalysis?: ImageAnalysis | null,
    subRules?: SubRulesContext | null
): Promise<TitleVariant[]> {
    const visualContext = imageAnalysis
        ? `\nPhoto: ${imageAnalysis.description} (${imageAnalysis.setting}, ${imageAnalysis.outfit}, ${imageAnalysis.mood})`
        : '';

    const hasEmojiRule = subRules?.titleRules?.some(r =>
        r.toLowerCase().includes('emoji') || r.toLowerCase().includes('no emoji')
    ) || false;

    const rulesSection = subRules && (subRules.titleRules.length > 0 || subRules.bannedWords.length > 0)
        ? `\n\n⚠️ SUBREDDIT-SPECIFIC RULES FOR r/${subreddit} (ALL titles MUST follow these):\n${subRules.titleRules.map(r => `- ${r}`).join('\n')}\n${subRules.bannedWords.length > 0 ? `- BANNED WORDS: ${subRules.bannedWords.join(', ')}` : ''}`
        : '';

    const emojiNote = hasEmojiRule
        ? '\n- DO NOT use any emojis — this sub bans them'
        : '\n- Use emojis sparingly (0-1 max). When in doubt, no emojis.';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 400,
            system: `Generate exactly 3 title variations for a Reddit photo post, each with a different strategy.
Each title should feel natural for r/${subreddit}.
${persona ? `Persona: ${persona}` : ''}

STRATEGIES:
1. "curiosity" — Make them curious to see the photo (e.g. "What do you think of my new look?")
2. "humor" — Light humor or playfulness (e.g. "My cat judges me when I take selfies")
3. "emotional" — Create connection (e.g. "Finally feeling confident")

RULES:
- Never include links, promotions, or call-to-actions
- Under 100 characters each
- Write in English
- Match the sub's culture${emojiNote}${rulesSection}

Respond with ONLY valid JSON array:
[
  {"title": "...", "style": "curiosity", "confidence": 80},
  {"title": "...", "style": "humor", "confidence": 70},
  {"title": "...", "style": "emotional", "confidence": 75}
]`,
            messages: [{
                role: 'user',
                content: `Caption: "${caption}"
Subreddit: r/${subreddit}
Bio: ${modelBio}${visualContext}

Generate 3 title variations.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const variants = JSON.parse(jsonMatch[0]) as TitleVariant[];
            return variants.filter(v => v.title && v.style);
        }
    } catch (err) {
        console.error('⚠️ A/B title generation error:', err instanceof Error ? err.message : err);
    }

    // Fallback: return single title
    return [{ title: caption, style: 'direct', confidence: 50 }];
}

// =============================================
// Vision-Guided Browser Interaction
// Claude sees the screen and tells us what to click
// =============================================

export interface VisionClickResult {
    action: 'click_text' | 'click_option' | 'type_text' | 'close' | 'none';
    target: string;
    explanation: string;
    allOptions?: string[];
}

/**
 * Send a screenshot to Claude Vision and ask what to do
 */
export async function analyzeScreenshot(
    screenshotBase64: string,
    question: string
): Promise<VisionClickResult> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 300,
            system: `You are a browser automation assistant. You see a screenshot of a Reddit page.
Your job is to identify what needs to be clicked or interacted with.

ALWAYS respond with valid JSON:
{
  "action": "click_text" | "click_option" | "type_text" | "close" | "none",
  "target": "EXACT visible text of the button/option to click",
  "explanation": "brief reason",
  "allOptions": ["option1", "option2"]
}

RULES:
- "target" must be the EXACT visible text as shown on screen — case sensitive
- For flair modals: pick a safe/generic flair, list ALL options in allOptions
- For confirmation dialogs: identify the confirm/accept button text
- If nothing needs to be done, use action "none"
- If a dialog should be dismissed, use action "close"`,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: screenshotBase64,
                        },
                    },
                    { type: 'text', text: question },
                ],
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]) as VisionClickResult;
            console.log(`  🧠 Claude Vision: ${result.action} → "${result.target}" (${result.explanation})`);
            return result;
        }
    } catch (err) {
        console.error('⚠️ Vision analysis failed:', err instanceof Error ? err.message : err);
    }

    return { action: 'none', target: '', explanation: 'analysis failed' };
}

/**
 * Take screenshot and ask Claude what to click
 */
export async function askClaudeWhatToClick(
    page: { screenshot: (opts?: Record<string, unknown>) => Promise<Buffer> },
    question: string
): Promise<VisionClickResult> {
    try {
        const screenshot = await page.screenshot({ type: 'png', fullPage: true });
        const base64 = screenshot.toString('base64');
        return await analyzeScreenshot(base64, question);
    } catch (err) {
        console.error('⚠️ Screenshot failed:', err instanceof Error ? err.message : err);
        return { action: 'none', target: '', explanation: 'screenshot failed' };
    }
}
