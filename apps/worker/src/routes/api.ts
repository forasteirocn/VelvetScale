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
