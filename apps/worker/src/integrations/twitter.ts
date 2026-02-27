import { TwitterApi, type TweetV2PostTweetResult } from 'twitter-api-v2';
import { getSupabaseAdmin } from '@velvetscale/db';
import axios from 'axios';

// =============================================
// VelvetScale Twitter/X Integration
// Posts, DMs, and media upload via official API
// Uses Free tier (500 writes/month)
//
// Auth modes:
//   1. OAuth 1.0a via .env (simple, single model)
//   2. OAuth 2.0 via DB tokens (multi-model, future)
// =============================================

// Cache of authenticated clients per model
const clientCache: Map<string, { client: TwitterApi; rawToken: string; expiresAt: number }> = new Map();

/**
 * Get an authenticated Twitter client for a model
 * Returns both the client and the raw access token (needed for v2 media upload)
 */
export async function getTwitterClient(modelId: string): Promise<{ client: TwitterApi; rawToken: string } | null> {
    // Check cache first
    const cached = clientCache.get(modelId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
        return { client: cached.client, rawToken: cached.rawToken };
    }

    // === Strategy 1: Check DB for model-specific tokens (OAuth 2.0) ===
    const supabase = getSupabaseAdmin();
    const { data: model } = await supabase
        .from('models')
        .select('twitter_access_token, twitter_refresh_token, twitter_token_expires_at')
        .eq('id', modelId)
        .single();

    if (model?.twitter_access_token) {
        const expiresAt = model.twitter_token_expires_at
            ? new Date(model.twitter_token_expires_at).getTime()
            : Date.now() + 365 * 24 * 60 * 60 * 1000;

        // If OAuth 2.0 token needs refresh
        if (model.twitter_refresh_token && expiresAt < Date.now() + 5 * 60 * 1000) {
            try {
                const refreshed = await refreshTwitterToken(modelId, model.twitter_refresh_token);
                if (refreshed) {
                    clientCache.set(modelId, { client: refreshed.client, rawToken: refreshed.rawToken, expiresAt: refreshed.expiresAt });
                    return { client: refreshed.client, rawToken: refreshed.rawToken };
                }
            } catch (err) {
                console.error('⚠️ Twitter token refresh failed:', err instanceof Error ? err.message : err);
            }
        }

        const client = new TwitterApi(model.twitter_access_token);
        clientCache.set(modelId, { client, rawToken: model.twitter_access_token, expiresAt });
        return { client, rawToken: model.twitter_access_token };
    }

    // === Strategy 2: Use .env OAuth 1.0a credentials (single model) ===
    const appKey = process.env.TWITTER_CONSUMER_KEY;
    const appSecret = process.env.TWITTER_CONSUMER_SECRET;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessSecret = process.env.TWITTER_ACCESS_SECRET;

    if (appKey && appSecret && accessToken && accessSecret) {
        console.log(`  🔑 Twitter OAuth 1.0a credentials loaded:`);
        console.log(`     appKey: ${appKey.substring(0, 5)}...${appKey.substring(appKey.length - 3)} (${appKey.length} chars)`);
        console.log(`     appSecret: ${appSecret.substring(0, 5)}...${appSecret.substring(appSecret.length - 3)} (${appSecret.length} chars)`);
        console.log(`     accessToken: ${accessToken.substring(0, 10)}... (${accessToken.length} chars)`);
        console.log(`     accessSecret: ${accessSecret.substring(0, 5)}...${accessSecret.substring(accessSecret.length - 3)} (${accessSecret.length} chars)`);

        const client = new TwitterApi({
            appKey,
            appSecret,
            accessToken,
            accessSecret,
        });

        const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
        clientCache.set(modelId, { client, rawToken: accessToken, expiresAt });
        return { client, rawToken: accessToken };
    }

    console.log(`⚠️ Model ${modelId.substring(0, 8)} has no Twitter credentials (check DB or .env)`);
    return null;
}

/**
 * Refresh an expired OAuth 2.0 token (multi-model future)
 */
async function refreshTwitterToken(
    modelId: string,
    refreshToken: string
): Promise<{ client: TwitterApi; rawToken: string; expiresAt: number } | null> {
    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('❌ TWITTER_CLIENT_ID or TWITTER_CLIENT_SECRET not set');
        return null;
    }

    const tempClient = new TwitterApi({ clientId, clientSecret });

    const { accessToken, refreshToken: newRefresh, expiresIn } =
        await tempClient.refreshOAuth2Token(refreshToken);

    const expiresAt = Date.now() + (expiresIn || 7200) * 1000;

    // Save new tokens
    const supabase = getSupabaseAdmin();
    await supabase
        .from('models')
        .update({
            twitter_access_token: accessToken,
            twitter_refresh_token: newRefresh || refreshToken,
            twitter_token_expires_at: new Date(expiresAt).toISOString(),
        })
        .eq('id', modelId);

    const client = new TwitterApi(accessToken);
    return { client, rawToken: accessToken, expiresAt };
}

// =============================================
// Posting
// =============================================

/**
 * Post a tweet with optional photo
 * Returns tweet URL on success
 */
export async function postTweet(
    modelId: string,
    text: string,
    photoUrl?: string
): Promise<{ success: boolean; url?: string; tweetId?: string; error?: string }> {
    const auth = await getTwitterClient(modelId);
    if (!auth) {
        return { success: false, error: 'No Twitter credentials for this model' };
    }

    const { client } = auth;

    try {
        let mediaId: string | undefined;

        // Upload media if provided
        if (photoUrl) {
            mediaId = await uploadMediaWithClient(client, photoUrl);
            if (!mediaId) {
                console.log('  ⚠️ Media upload failed, posting text-only tweet instead');
            }
        }

        // Post the tweet
        const tweetData: any = { text };
        if (mediaId) {
            tweetData.media = { media_ids: [mediaId] };
        }

        console.log(`  🔄 Posting tweet via v2 API...`);
        const result: TweetV2PostTweetResult = await client.v2.tweet(tweetData);

        const tweetId = result.data.id;
        const tweetUrl = `https://x.com/i/status/${tweetId}`;

        // Track write usage
        await trackWriteUsage(modelId, 'tweet');

        console.log(`  ✅ Tweet posted: ${tweetUrl}`);
        return { success: true, url: tweetUrl, tweetId };

    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Tweet failed: ${errMsg}`);
        return { success: false, error: errMsg };
    }
}

/**
 * Post a reply to a tweet (for threads)
 */
export async function postReply(
    modelId: string,
    replyToTweetId: string,
    text: string
): Promise<{ success: boolean; tweetId?: string; error?: string }> {
    const auth = await getTwitterClient(modelId);
    if (!auth) {
        return { success: false, error: 'No Twitter credentials' };
    }

    try {
        const { client } = auth;
        const result = await client.v2.tweet({
            text,
            reply: { in_reply_to_tweet_id: replyToTweetId },
        });

        await trackWriteUsage(modelId, 'reply');
        return { success: true, tweetId: result.data.id };
    } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// =============================================
// Direct Messages
// =============================================

/**
 * Send a DM to a user
 */
export async function sendDM(
    modelId: string,
    recipientUserId: string,
    text: string
): Promise<{ success: boolean; error?: string }> {
    const auth = await getTwitterClient(modelId);
    if (!auth) {
        return { success: false, error: 'No Twitter credentials' };
    }

    const { client } = auth;
    try {
        await client.v2.sendDmInConversation(
            // Create a new conversation with the recipient
            await getOrCreateDMConversation(client, recipientUserId),
            { text }
        );

        await trackWriteUsage(modelId, 'dm');
        console.log(`  📩 DM sent to user ${recipientUserId}`);
        return { success: true };
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Fallback: try creating new conversation directly
        try {
            await client.v2.sendDmToParticipant(recipientUserId, { text });
            await trackWriteUsage(modelId, 'dm');
            console.log(`  📩 DM sent to user ${recipientUserId} (fallback)`);
            return { success: true };
        } catch (err2: unknown) {
            const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(`  ❌ DM failed: ${errMsg2}`);
            return { success: false, error: errMsg2 };
        }
    }
}

/**
 * Get or create a DM conversation ID with a user
 */
async function getOrCreateDMConversation(
    client: TwitterApi,
    recipientUserId: string
): Promise<string> {
    // The v2 API creates conversations implicitly
    // We just need the conversation ID format: {lower_id}-{higher_id}
    const me = await client.v2.me();
    const myId = me.data.id;
    const ids = [myId, recipientUserId].sort();
    return `${ids[0]}-${ids[1]}`;
}

/**
 * Check for new DM responses (used by collab hunter)
 * Returns new messages since last check
 */
export async function checkNewDMs(
    modelId: string,
    sinceId?: string
): Promise<Array<{ senderId: string; senderName: string; text: string; dmId: string }>> {
    const auth = await getTwitterClient(modelId);
    if (!auth) return [];

    const { client } = auth;
    try {
        const dmEvents = await client.v2.listDmEvents({
            max_results: 20,
            event_types: 'MessageCreate',
            ...(sinceId ? { since_id: sinceId } : {}),
        });

        const me = await client.v2.me();
        const myId = me.data.id;

        const newMessages: Array<{ senderId: string; senderName: string; text: string; dmId: string }> = [];

        for (const event of dmEvents.data?.data || []) {
            // Skip our own messages
            if (event.sender_id === myId) continue;

            newMessages.push({
                senderId: event.sender_id || '',
                senderName: event.sender_id || '', // Will be resolved later
                text: (event as any).text || '',
                dmId: event.id,
            });
        }

        return newMessages;
    } catch (err) {
        console.error('⚠️ Failed to check DMs:', err instanceof Error ? err.message : err);
        return [];
    }
}

// =============================================
// Media Upload (uses twitter-api-v2 library)
// The library handles OAuth signing + init/append/finalize internally
// =============================================

/**
 * Upload media (photo) to Twitter using the twitter-api-v2 library
 * Uses client.v2.uploadMedia() which handles the full v2 upload flow
 */
async function uploadMediaWithClient(client: TwitterApi, photoUrl: string): Promise<string | undefined> {
    try {
        // Download the image
        console.log(`  📸 Downloading image from ${photoUrl.substring(0, 60)}...`);
        const response = await axios.get(photoUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        const buffer = Buffer.from(response.data);
        let contentType = response.headers['content-type'] || 'image/jpeg';

        // Normalize content type
        if (contentType === 'application/octet-stream' || !contentType.startsWith('image/')) {
            contentType = 'image/jpeg';
        }

        console.log(`  📸 Uploading media v2 (${(buffer.length / 1024).toFixed(0)}KB, ${contentType})...`);

        // Use the library's built-in v2 upload — handles OAuth signing + init/append/finalize
        const mediaId = await client.v2.uploadMedia(buffer, {
            media_type: contentType as any,
            media_category: 'tweet_image',
        });

        console.log(`  📸 Media uploaded successfully: ${mediaId}`);
        return mediaId;
    } catch (err: any) {
        const errData = err?.data || err?.response?.data;
        const errCode = err?.code || err?.response?.status;
        const errDetail = errData
            ? (typeof errData === 'string' ? errData : JSON.stringify(errData))
            : (err instanceof Error ? err.message : String(err));
        console.error(`⚠️ Media upload failed:`);
        console.error(`   Code: ${errCode || 'N/A'}`);
        console.error(`   Detail: ${errDetail}`);
        return undefined;
    }
}


// =============================================
// Write Budget Tracking
// =============================================

/**
 * Track API write usage to stay within 500/month budget
 */
export async function trackWriteUsage(modelId: string, actionType: string): Promise<void> {
    const supabase = getSupabaseAdmin();
    await supabase.from('agent_logs').insert({
        model_id: modelId,
        action: `twitter_write_${actionType}`,
        platform: 'twitter',
        details: { timestamp: new Date().toISOString() },
    });
}

/**
 * Get current month's write count for budget tracking
 */
export async function getMonthlyWriteCount(modelId: string): Promise<number> {
    const supabase = getSupabaseAdmin();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { count } = await supabase
        .from('agent_logs')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', modelId)
        .eq('platform', 'twitter')
        .like('action', 'twitter_write_%')
        .gte('created_at', monthStart.toISOString());

    return count || 0;
}

/**
 * Check if we have budget remaining this month
 */
export async function hasWriteBudget(modelId: string, needed: number = 1): Promise<boolean> {
    const used = await getMonthlyWriteCount(modelId);
    const limit = 400; // Keep 100 as safety buffer from the 500 limit
    const remaining = limit - used;

    if (remaining < needed) {
        console.log(`  ⚠️ Twitter write budget low: ${used}/${limit} used, need ${needed}`);
        return false;
    }
    return true;
}

/**
 * Lookup a Twitter user by handle (for collab hunter)
 * Uses a read endpoint — consider using TwitterAPI.io for this
 */
export async function lookupUserByHandle(
    modelId: string,
    handle: string
): Promise<{ id: string; name: string; followers: number; description: string } | null> {
    const auth = await getTwitterClient(modelId);
    if (!auth) return null;

    try {
        const user = await auth.client.v2.userByUsername(handle, {
            'user.fields': ['public_metrics', 'description'],
        });

        if (!user.data) return null;

        return {
            id: user.data.id,
            name: user.data.name,
            followers: user.data.public_metrics?.followers_count || 0,
            description: user.data.description || '',
        };
    } catch {
        return null;
    }
}
