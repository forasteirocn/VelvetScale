import { Router, Request, Response } from 'express';
import { getSupabaseAdmin } from '@velvetscale/db';

export const apiRouter = Router();

// =============================================
// Model Dashboard API
// =============================================

// Get model's recent activity
apiRouter.get('/models/:id/activity', async (req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const modelId = req.params.id;

    try {
        const [postsResult, commandsResult, logsResult] = await Promise.all([
            supabase
                .from('posts')
                .select('*')
                .eq('model_id', modelId)
                .order('created_at', { ascending: false })
                .limit(20),
            supabase
                .from('commands')
                .select('*')
                .eq('model_id', modelId)
                .order('created_at', { ascending: false })
                .limit(10),
            supabase
                .from('agent_logs')
                .select('*')
                .eq('model_id', modelId)
                .order('created_at', { ascending: false })
                .limit(20),
        ]);

        res.json({
            success: true,
            data: {
                posts: postsResult.data || [],
                commands: commandsResult.data || [],
                logs: logsResult.data || [],
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch activity' });
    }
});

// Get model's subreddits
apiRouter.get('/models/:id/subreddits', async (req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const modelId = req.params.id;

    try {
        const { data, error } = await supabase
            .from('subreddits')
            .select('*')
            .eq('model_id', modelId)
            .order('subscribers', { ascending: false });

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch subreddits' });
    }
});

// Approve/reject a subreddit
apiRouter.patch('/subreddits/:id', async (req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const subredditId = req.params.id;
    const { is_approved } = req.body;

    try {
        const { error } = await supabase
            .from('subreddits')
            .update({ is_approved })
            .eq('id', subredditId);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update subreddit' });
    }
});

// Get model stats
apiRouter.get('/models/:id/stats', async (req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const modelId = req.params.id;

    try {
        const [
            { count: totalPosts },
            { count: publishedPosts },
            { count: failedPosts },
            { count: totalCommands },
            { count: subredditCount },
        ] = await Promise.all([
            supabase.from('posts').select('*', { count: 'exact', head: true }).eq('model_id', modelId),
            supabase.from('posts').select('*', { count: 'exact', head: true }).eq('model_id', modelId).eq('status', 'published'),
            supabase.from('posts').select('*', { count: 'exact', head: true }).eq('model_id', modelId).eq('status', 'failed'),
            supabase.from('commands').select('*', { count: 'exact', head: true }).eq('model_id', modelId),
            supabase.from('subreddits').select('*', { count: 'exact', head: true }).eq('model_id', modelId).eq('is_approved', true),
        ]);

        res.json({
            success: true,
            data: {
                totalPosts: totalPosts || 0,
                publishedPosts: publishedPosts || 0,
                failedPosts: failedPosts || 0,
                totalCommands: totalCommands || 0,
                approvedSubreddits: subredditCount || 0,
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
});

// Get model's social accounts
apiRouter.get('/models/:id/accounts', async (req: Request, res: Response) => {
    const supabase = getSupabaseAdmin();
    const modelId = req.params.id;

    try {
        const { data, error } = await supabase
            .from('social_accounts')
            .select('id, platform, username, is_active, created_at')
            .eq('model_id', modelId);

        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
    }
});

// Generate Reddit OAuth URL
apiRouter.get('/auth/reddit/url', (req: Request, res: Response) => {
    const modelId = req.query.model_id;
    if (!modelId) {
        res.status(400).json({ error: 'Missing model_id' });
        return;
    }

    const clientId = process.env.REDDIT_CLIENT_ID;
    const redirectUri = `${process.env.API_URL}/webhook/reddit/callback`;
    const scope = 'identity submit read privatemessages';

    const url = `https://www.reddit.com/api/v1/authorize?client_id=${clientId}&response_type=code&state=${modelId}&redirect_uri=${encodeURIComponent(redirectUri)}&duration=permanent&scope=${encodeURIComponent(scope)}`;

    res.json({ success: true, url });
});

// =============================================
// Twitter OAuth 2.0 PKCE Flow
// =============================================
import { TwitterApi } from 'twitter-api-v2';

// Store PKCE state temporarily (in production, use Redis)
const twitterOAuthState: Map<string, { codeVerifier: string; state: string; modelId: string }> = new Map();

// Step 1: Generate Twitter OAuth 2.0 auth URL
apiRouter.get('/auth/twitter/url', async (req: Request, res: Response) => {
    const modelId = req.query.model_id as string;
    if (!modelId) {
        res.status(400).json({ error: 'Missing model_id' });
        return;
    }

    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        res.status(500).json({ error: 'Twitter OAuth 2.0 credentials not configured' });
        return;
    }

    try {
        const twitterClient = new TwitterApi({ clientId, clientSecret });

        const callbackUrl = `${process.env.API_URL || 'http://localhost:3001'}/api/auth/twitter/callback`;

        const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
            callbackUrl,
            {
                scope: ['tweet.read', 'tweet.write', 'users.read', 'dm.read', 'dm.write', 'media.write', 'offline.access'],
            }
        );

        // Store state for callback verification
        twitterOAuthState.set(state, { codeVerifier, state, modelId });

        // Clean up old states after 10 minutes
        setTimeout(() => twitterOAuthState.delete(state), 10 * 60 * 1000);

        console.log(`🐦 Twitter OAuth URL generated for model ${modelId.substring(0, 8)}`);
        console.log(`🔗 ${url}`);

        res.json({ success: true, url });
    } catch (error) {
        console.error('❌ Failed to generate Twitter auth URL:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

// Step 2: Handle Twitter OAuth 2.0 callback
apiRouter.get('/auth/twitter/callback', async (req: Request, res: Response) => {
    const { code, state } = req.query as { code: string; state: string };

    if (!code || !state) {
        res.status(400).send('Missing code or state parameter');
        return;
    }

    const storedState = twitterOAuthState.get(state);
    if (!storedState) {
        res.status(400).send('Invalid or expired state. Please try again.');
        return;
    }

    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        res.status(500).send('Twitter OAuth 2.0 not configured');
        return;
    }

    try {
        const twitterClient = new TwitterApi({ clientId, clientSecret });
        const callbackUrl = `${process.env.API_URL || 'http://localhost:3001'}/api/auth/twitter/callback`;

        const { accessToken, refreshToken, expiresIn } = await twitterClient.loginWithOAuth2({
            code,
            codeVerifier: storedState.codeVerifier,
            redirectUri: callbackUrl,
        });

        const expiresAt = new Date(Date.now() + (expiresIn || 7200) * 1000).toISOString();

        // Get the authenticated user info
        const loggedClient = new TwitterApi(accessToken);
        const me = await loggedClient.v2.me();

        // Save tokens to DB
        const supabase = getSupabaseAdmin();
        await supabase.from('models').update({
            twitter_handle: me.data.username,
            twitter_access_token: accessToken,
            twitter_refresh_token: refreshToken,
            twitter_token_expires_at: expiresAt,
        }).eq('id', storedState.modelId);

        // Clean up state
        twitterOAuthState.delete(state);

        console.log(`✅ Twitter OAuth 2.0 connected: @${me.data.username} for model ${storedState.modelId.substring(0, 8)}`);

        res.send(`
            <html>
            <body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                <div style="text-align:center">
                    <h1>✅ Twitter Conectado!</h1>
                    <p>Conta: <strong>@${me.data.username}</strong></p>
                    <p>Pode fechar esta janela.</p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('❌ Twitter OAuth callback failed:', error);
        res.status(500).send('Authentication failed. Please try again.');
    }
});

