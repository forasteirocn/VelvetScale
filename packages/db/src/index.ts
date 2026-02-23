import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Singleton Supabase clients
let supabaseClient: SupabaseClient | null = null;
let supabaseAdmin: SupabaseClient | null = null;

/**
 * Get the public Supabase client (uses anon key, respects RLS)
 */
export function getSupabase(): SupabaseClient {
    if (!supabaseClient) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_ANON_KEY;
        if (!url || !key) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
        }
        supabaseClient = createClient(url, key);
    }
    return supabaseClient;
}

/**
 * Get the admin Supabase client (uses service role key, bypasses RLS)
 */
export function getSupabaseAdmin(): SupabaseClient {
    if (!supabaseAdmin) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
        }
        supabaseAdmin = createClient(url, key, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }
    return supabaseAdmin;
}

export { createClient, SupabaseClient };
