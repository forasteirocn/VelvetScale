// ============================================
// VelvetScale — Shared Types
// ============================================

// --- Model (content creator) ---
export interface Model {
    id: string;
    name: string;
    email: string;
    phone: string;
    onlyfans_url?: string;
    privacy_url?: string;
    bio?: string;
    persona?: string;
    status: 'pending' | 'active' | 'suspended';
    plan: 'basic' | 'pro' | 'enterprise';
    enabled_platforms?: { reddit?: boolean; twitter?: boolean };
    created_at: string;
}

// --- Social Accounts ---
export type Platform = 'reddit' | 'twitter';

export interface SocialAccount {
    id: string;
    model_id: string;
    platform: Platform;
    username: string;
    access_token?: string;
    refresh_token?: string;
    token_expires_at?: string;
    is_active: boolean;
    created_at: string;
}

// --- Posts ---
export type PostType = 'post' | 'tweet' | 'comment' | 'reply' | 'thread';
export type PostStatus = 'pending' | 'scheduled' | 'published' | 'failed' | 'deleted';

export interface Post {
    id: string;
    model_id: string;
    social_account_id: string;
    platform: Platform;
    post_type: PostType;
    content: string;
    media_urls?: string[];
    external_id?: string;
    external_url?: string;
    subreddit?: string;
    status: PostStatus;
    scheduled_for?: string;
    published_at?: string;
    engagement?: PostEngagement;
    created_at: string;
}

export interface PostEngagement {
    likes?: number;
    comments?: number;
    shares?: number;
    views?: number;
    upvotes?: number;
    downvotes?: number;
}

// --- Commands (WhatsApp) ---
export type CommandStatus = 'received' | 'processing' | 'completed' | 'failed';

export type CommandIntent =
    | 'post_reddit'
    | 'post_twitter'
    | 'find_subreddits'
    | 'check_engagement'
    | 'schedule_post'
    | 'get_stats'
    | 'unknown';

export interface Command {
    id: string;
    model_id: string;
    raw_message: string;
    parsed_intent?: CommandIntent;
    parsed_params?: Record<string, unknown>;
    status: CommandStatus;
    result_message?: string;
    created_at: string;
}

// --- Subreddits ---
export interface Subreddit {
    id: string;
    model_id: string;
    name: string;
    category?: string;
    nsfw: boolean;
    subscribers?: number;
    posting_rules?: Record<string, unknown>;
    last_posted_at?: string;
    is_approved: boolean;
    created_at: string;
}

// --- Agent Logs ---
export interface AgentLog {
    id: string;
    model_id: string;
    action: string;
    platform?: Platform;
    details?: Record<string, unknown>;
    tokens_used?: number;
    cost_usd?: number;
    created_at: string;
}

// --- Queue Job Types ---
export interface PostJobData {
    model_id: string;
    platform: Platform;
    content: string;
    subreddit?: string;
    media_urls?: string[];
    social_account_id: string;
}

export interface CommandJobData {
    command_id: string;
    model_id: string;
    raw_message: string;
    phone: string;
}

export interface DiscoveryJobData {
    model_id: string;
    bio: string;
    niche?: string;
}

// --- API Response Types ---
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

// --- WhatsApp Webhook Types ---
export interface WhatsAppMessage {
    from: string;
    id: string;
    timestamp: string;
    text?: {
        body: string;
    };
    type: 'text' | 'image' | 'video' | 'document' | 'audio';
}

export interface WhatsAppWebhookPayload {
    object: string;
    entry: Array<{
        id: string;
        changes: Array<{
            value: {
                messaging_product: string;
                metadata: {
                    display_phone_number: string;
                    phone_number_id: string;
                };
                messages?: WhatsAppMessage[];
                statuses?: Array<{
                    id: string;
                    status: string;
                    timestamp: string;
                }>;
            };
            field: string;
        }>;
    }>;
}

// --- Platform Toggle Helper ---

/**
 * Check if a platform is enabled for a model.
 * Default: reddit=true, twitter=false (for new models).
 */
export function isPlatformEnabled(
    model: { enabled_platforms?: any; id?: string },
    platform: 'reddit' | 'twitter'
): boolean {
    if (!model.enabled_platforms) {
        if (platform === 'twitter') {
            console.log(`  ⚠️ ${platform} DESABILITADO para modelo ${model.id?.substring(0, 8) || '?'} (enabled_platforms é null — rode: UPDATE models SET enabled_platforms = '{"reddit":true,"twitter":true}'::jsonb WHERE id = '...')`);
        }
        return platform === 'reddit';
    }
    const enabled = model.enabled_platforms[platform] === true;
    if (!enabled && platform === 'twitter') {
        console.log(`  ⚠️ ${platform} DESABILITADO para modelo ${model.id?.substring(0, 8) || '?'} (enabled_platforms.twitter = false)`);
    }
    return enabled;
}
