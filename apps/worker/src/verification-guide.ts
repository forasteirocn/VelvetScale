import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { sendTelegramMessage } from './integrations/telegram';
import { getSubRules } from './anti-ban';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Verification Guide
// Analyzes subs that need verification and sends
// step-by-step guides via Telegram
// Runs once per day
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

let guideInterval: ReturnType<typeof setInterval> | null = null;

export function startVerificationGuide(): void {
    if (guideInterval) return;

    console.log('🔍 Verification Guide iniciado (diário, executa imediatamente)');

    // Execute immediately, then every 24h
    scanVerificationSubs();
    guideInterval = setInterval(scanVerificationSubs, 24 * 60 * 60 * 1000);
}

export function stopVerificationGuide(): void {
    if (guideInterval) {
        clearInterval(guideInterval);
        guideInterval = null;
    }
}

// =============================================
// 1. Get Reddit account info (karma, age, username)
// =============================================

interface RedditAccountInfo {
    username: string;
    totalKarma: number;
    postKarma: number;
    commentKarma: number;
    accountAge: string; // human-readable
    accountAgeDays: number;
    isVerifiedEmail: boolean;
}

/**
 * Fetch Reddit account info by loading the user profile page JSON
 * Uses the model's stored cookies to get the authenticated user data
 */
async function getRedditAccountInfo(modelId: string): Promise<RedditAccountInfo | null> {
    try {
        const path = await import('path');
        const fs = await import('fs');
        const cookiePath = path.join(process.cwd(), '.reddit-sessions', `${modelId}.json`);

        if (!fs.existsSync(cookiePath)) {
            return null;
        }

        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));

        // Extract username from cookies (reddit_session cookie or display_name)
        // Try to get username from the cookie data
        let username = '';
        for (const cookie of cookies) {
            if (cookie.name === 'reddit_session' || cookie.name === 'user') {
                // The value sometimes contains the username
                try {
                    const decoded = decodeURIComponent(cookie.value);
                    const parts = decoded.split(',');
                    if (parts[0] && parts[0].length < 30) {
                        username = parts[0];
                    }
                } catch { /* ignore */ }
            }
        }

        // Build cookie string for HTTP request
        const cookieStr = cookies
            .filter((c: any) => c.domain?.includes('reddit'))
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');

        // Fetch /api/me.json with cookies to get the authenticated user info
        const response = await axios.get('https://www.reddit.com/api/me.json', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Cookie': cookieStr,
            },
            timeout: 15000,
        });

        const data = response.data?.data || response.data;
        if (!data || !data.name) {
            // Fallback: try old.reddit.com
            const fallbackRes = await axios.get('https://old.reddit.com/api/me.json', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Cookie': cookieStr,
                },
                timeout: 15000,
            });
            const fbData = fallbackRes.data?.data || fallbackRes.data;
            if (!fbData?.name) return null;
            return parseAccountInfo(fbData);
        }

        return parseAccountInfo(data);
    } catch (err) {
        console.error(`  ⚠️ Failed to fetch Reddit account info:`, err instanceof Error ? err.message : err);
        return null;
    }
}

function parseAccountInfo(data: any): RedditAccountInfo {
    const createdUtc = data.created_utc || data.created || 0;
    const ageMs = Date.now() - createdUtc * 1000;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    let ageStr: string;
    if (ageDays < 30) {
        ageStr = `${ageDays} dias`;
    } else if (ageDays < 365) {
        ageStr = `${Math.floor(ageDays / 30)} meses`;
    } else {
        const years = Math.floor(ageDays / 365);
        const months = Math.floor((ageDays % 365) / 30);
        ageStr = months > 0 ? `${years} ano(s) e ${months} meses` : `${years} ano(s)`;
    }

    return {
        username: data.name || 'unknown',
        totalKarma: data.total_karma || (data.link_karma || 0) + (data.comment_karma || 0),
        postKarma: data.link_karma || 0,
        commentKarma: data.comment_karma || 0,
        accountAge: ageStr,
        accountAgeDays: ageDays,
        isVerifiedEmail: data.has_verified_email || false,
    };
}

// =============================================
// 2. Fetch detailed verification instructions
// =============================================

interface VerificationGuide {
    subName: string;
    steps: string[];
    karmaRequired: number | null;
    accountAgeRequired: string | null;
    verificationLink: string | null;
    difficulty: 'fácil' | 'médio' | 'difícil';
    isEligible: boolean;
    eligibilityReason: string;
}

/**
 * Use Claude to parse sub rules into a verification guide
 */
async function generateVerificationGuide(
    subName: string,
    rawRules: string,
    aboutDescription: string,
    accountInfo: RedditAccountInfo | null
): Promise<VerificationGuide> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: `You analyze subreddit verification requirements and create a clear guide.

Given the subreddit rules and description, extract:
1. Step-by-step verification instructions (what to do, where to submit)
2. Karma requirements (if mentioned)
3. Account age requirements (if mentioned)
4. Link to verification post/wiki (if mentioned)
5. Difficulty level (easy/medium/hard)

${accountInfo ? `
User's current stats:
- Username: u/${accountInfo.username}
- Total karma: ${accountInfo.totalKarma}
- Post karma: ${accountInfo.postKarma}
- Comment karma: ${accountInfo.commentKarma}
- Account age: ${accountInfo.accountAge} (${accountInfo.accountAgeDays} days)
- Verified email: ${accountInfo.isVerifiedEmail}
` : ''}

Respond with JSON:
{
  "steps": ["Passo 1: ...", "Passo 2: ...", "Passo 3: ..."],
  "karmaRequired": number or null,
  "accountAgeRequired": "string" or null,
  "verificationLink": "URL" or null,
  "difficulty": "fácil" | "médio" | "difícil",
  "isEligible": true/false,
  "eligibilityReason": "reason in Portuguese"
}

IMPORTANT:
- Write ALL steps in Portuguese (Brazilian)
- Be VERY specific: mention modmail, verification posts, photo requirements
- Most NSFW subs require a photo holding a paper with the sub name + your username
- If the sub uses a verification bot, mention it
- For eligibility, check karma and account age against requirements`,
            messages: [{
                role: 'user',
                content: `Subreddit: r/${subName}

Description: ${aboutDescription.substring(0, 500)}

Rules:
${rawRules.substring(0, 2000)}

Generate a verification guide in Portuguese.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as VerificationGuide;
            parsed.subName = subName;
            return parsed;
        }
    } catch (err) {
        console.error(`  ⚠️ Guide generation error for r/${subName}:`, err instanceof Error ? err.message : err);
    }

    // Default fallback
    return {
        subName,
        steps: [
            'Envie uma mensagem (modmail) para os moderadores do sub',
            'Inclua uma foto segurando um papel com: nome do sub + seu username + data',
            'Aguarde aprovação dos mods (pode levar 24-72h)',
        ],
        karmaRequired: null,
        accountAgeRequired: null,
        verificationLink: null,
        difficulty: 'médio',
        isEligible: true,
        eligibilityReason: 'Sem requisitos específicos identificados',
    };
}

// =============================================
// 3. Main scan: find subs needing verification
// =============================================

async function scanVerificationSubs(): Promise<void> {
    console.log('🔍 Verificação Guide: Escaneando subs que precisam de verificação...');

    const supabase = getSupabaseAdmin();

    // Get all active models with reddit enabled
    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona, enabled_platforms')
        .eq('status', 'active');

    if (!models?.length) {
        console.log('🔍 Verification Guide: Nenhum modelo ativo');
        return;
    }

    for (const model of models) {
        if (!isPlatformEnabled(model, 'reddit')) continue;

        try {
            await scanForModel(model);
        } catch (err) {
            console.error(`❌ Verification Guide error for ${model.id}:`, err);
        }
    }
}

async function scanForModel(
    model: { id: string; phone: string; bio: string; persona: string }
): Promise<void> {
    const supabase = getSupabaseAdmin();

    // 1. Find subs that need verification (and haven't been notified recently)
    const { data: subs } = await supabase
        .from('subreddits')
        .select('name, needs_verification, posting_rules, member_count')
        .eq('model_id', model.id)
        .eq('is_approved', true)
        .eq('needs_verification', true);

    if (!subs?.length) {
        console.log(`  🔍 ${model.id.substring(0, 8)}: Nenhum sub pendente de verificação`);
        return;
    }

    // Check if we already sent a guide today (avoid spam)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const { count: alreadySent } = await supabase
        .from('agent_logs')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', model.id)
        .eq('action', 'verification_guide_sent')
        .gte('created_at', todayStart.toISOString());

    if ((alreadySent || 0) > 0) {
        console.log(`  🔍 ${model.id.substring(0, 8)}: Guia já enviado hoje, pulando`);
        return;
    }

    // 2. Get Reddit account info (karma, age)
    console.log(`  🔍 Buscando info da conta Reddit para ${model.id.substring(0, 8)}...`);
    const accountInfo = await getRedditAccountInfo(model.id);

    if (accountInfo) {
        console.log(`  👤 u/${accountInfo.username}: ${accountInfo.totalKarma} karma, conta ${accountInfo.accountAge}`);
    } else {
        console.log(`  ⚠️ Não conseguiu buscar info da conta Reddit`);
    }

    // 3. Generate guides for each sub
    const guides: VerificationGuide[] = [];

    for (const sub of subs) {
        console.log(`  📋 Analisando regras de r/${sub.name}...`);

        // Fetch fresh rules
        let rawRules = '';
        let description = '';

        try {
            const [rulesRes, aboutRes] = await Promise.all([
                axios.get(`https://www.reddit.com/r/${sub.name}/about/rules.json`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                    timeout: 10000,
                }).catch(() => ({ data: { rules: [] } })),
                axios.get(`https://www.reddit.com/r/${sub.name}/about.json`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                    timeout: 10000,
                }).catch(() => ({ data: { data: {} } })),
            ]);

            const rulesList = rulesRes.data?.rules || [];
            rawRules = rulesList.map((r: any) =>
                `${r.short_name || ''}: ${r.description || ''}`.trim()
            ).join('\n');

            const aboutData = aboutRes.data?.data || {};
            description = aboutData.public_description || aboutData.description || '';

            // Also try to find verification-specific wiki/sticky
            try {
                const wikiRes = await axios.get(`https://www.reddit.com/r/${sub.name}/wiki/verification.json`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                    timeout: 10000,
                });
                const wikiContent = wikiRes.data?.data?.content_md || '';
                if (wikiContent) {
                    rawRules += '\n\n--- VERIFICATION WIKI ---\n' + wikiContent.substring(0, 1500);
                }
            } catch { /* no wiki page */ }

        } catch { /* ignore fetch errors */ }

        const guide = await generateVerificationGuide(
            sub.name,
            rawRules || 'No specific rules found',
            description,
            accountInfo
        );

        guides.push(guide);

        // Rate limit between subs
        await new Promise(r => setTimeout(r, 2000));
    }

    if (!guides.length) return;

    // 4. Send comprehensive Telegram message
    await sendVerificationReport(model.phone, accountInfo, guides);

    // 5. Log that we sent the guide
    await supabase.from('agent_logs').insert({
        model_id: model.id,
        action: 'verification_guide_sent',
        details: {
            subsScanned: guides.length,
            eligible: guides.filter(g => g.isEligible).length,
            notEligible: guides.filter(g => !g.isEligible).length,
            accountKarma: accountInfo?.totalKarma || null,
        },
    });

    console.log(`  ✅ Verification guide sent for ${model.id.substring(0, 8)} (${guides.length} subs)`);
}

// =============================================
// 4. Build and send Telegram report
// =============================================

async function sendVerificationReport(
    chatId: string,
    accountInfo: RedditAccountInfo | null,
    guides: VerificationGuide[]
): Promise<void> {
    // Build header with account stats
    let msg = '🔐 *GUIA DE VERIFICAÇÃO*\n\n';

    if (accountInfo) {
        const safeUser = accountInfo.username.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        msg += `👤 *Sua conta:* u/${safeUser}\n`;
        msg += `⭐ Karma total: ${accountInfo.totalKarma.toLocaleString('pt-BR')}\n`;
        msg += `📝 Post karma: ${accountInfo.postKarma.toLocaleString('pt-BR')}\n`;
        msg += `💬 Comment karma: ${accountInfo.commentKarma.toLocaleString('pt-BR')}\n`;
        msg += `📅 Idade da conta: ${accountInfo.accountAge}\n`;
        msg += `📧 Email verificado: ${accountInfo.isVerifiedEmail ? 'Sim ✅' : 'Não ❌'}\n`;
        msg += '\n━━━━━━━━━━━━━━━━━\n\n';
    }

    // Separate eligible and not eligible
    const eligible = guides.filter(g => g.isEligible);
    const notEligible = guides.filter(g => !g.isEligible);

    // Send eligible subs first
    if (eligible.length > 0) {
        msg += `✅ *${eligible.length} sub(s) prontos para verificar:*\n\n`;

        for (const guide of eligible) {
            msg += formatGuideMessage(guide);
        }
    }

    if (notEligible.length > 0) {
        if (eligible.length > 0) msg += '\n━━━━━━━━━━━━━━━━━\n\n';
        msg += `❌ *${notEligible.length} sub(s) ainda não elegíveis:*\n\n`;

        for (const guide of notEligible) {
            msg += formatGuideMessage(guide);
        }
    }

    msg += '\n💡 _Verificação é manual. Siga os passos acima para cada sub._';
    msg += '\n_Após verificar, os posts nesse sub serão retomados automaticamente!_';

    // Telegram has a 4096 char limit per message
    if (msg.length > 4000) {
        // Split into multiple messages
        const header = msg.substring(0, msg.indexOf('━━━━━━━━━━━━━━━━━') + 20);
        await sendTelegramMessage(Number(chatId), header);

        for (const guide of guides) {
            const subMsg = formatGuideMessage(guide);
            await sendTelegramMessage(Number(chatId), subMsg);
            await new Promise(r => setTimeout(r, 500));
        }
    } else {
        await sendTelegramMessage(Number(chatId), msg);
    }
}

function formatGuideMessage(guide: VerificationGuide): string {
    const safeName = guide.subName.replace(/_/g, '\\_');
    const statusIcon = guide.isEligible ? '✅' : '❌';
    const difficultyIcon = guide.difficulty === 'fácil' ? '🟢' : guide.difficulty === 'médio' ? '🟡' : '🔴';

    let msg = `${statusIcon} *r/${safeName}* ${difficultyIcon} ${guide.difficulty}\n`;

    if (guide.karmaRequired) {
        msg += `   ⭐ Karma necessário: ${guide.karmaRequired.toLocaleString('pt-BR')}\n`;
    }
    if (guide.accountAgeRequired) {
        msg += `   📅 Idade mínima: ${guide.accountAgeRequired}\n`;
    }
    if (!guide.isEligible) {
        const safeReason = guide.eligibilityReason.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ');
        msg += `   ⚠️ _${safeReason}_\n`;
    }

    msg += '\n';
    for (let i = 0; i < guide.steps.length; i++) {
        const safeStep = guide.steps[i].replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ');
        msg += `   ${i + 1}\\. ${safeStep}\n`;
    }

    if (guide.verificationLink) {
        msg += `   🔗 Link: ${guide.verificationLink}\n`;
    }

    msg += '\n';
    return msg;
}

// =============================================
// 5. Manual trigger via Telegram command
// =============================================

/**
 * Manually trigger verification scan for a model
 * Called from Telegram command handler
 */
export async function triggerVerificationGuide(modelId: string, chatId: number): Promise<void> {
    await sendTelegramMessage(chatId, '🔍 Analisando subs que precisam de verificação...');

    const supabase = getSupabaseAdmin();

    const { data: model } = await supabase
        .from('models')
        .select('id, phone, bio, persona')
        .eq('id', modelId)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, '⚠️ Modelo não encontrado');
        return;
    }

    // Also scan ALL subs (not just flagged ones) to detect new verification requirements
    const { data: allSubs } = await supabase
        .from('subreddits')
        .select('name, needs_verification, posting_rules, member_count')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('is_banned', false);

    if (!allSubs?.length) {
        await sendTelegramMessage(chatId, '⚠️ Nenhum subreddit aprovado encontrado');
        return;
    }

    // Force-scan rules for all subs to detect verification requirements
    let newlyFlagged = 0;
    for (const sub of allSubs) {
        if (sub.needs_verification) continue; // Already flagged

        try {
            const rules = await getSubRules(sub.name);
            if (rules?.requiresVerification) {
                await supabase
                    .from('subreddits')
                    .update({ needs_verification: true })
                    .eq('model_id', modelId)
                    .eq('name', sub.name);
                newlyFlagged++;
                console.log(`  🔒 Newly flagged: r/${sub.name} requires verification`);
            }
        } catch { /* ignore */ }

        // Rate limit
        await new Promise(r => setTimeout(r, 1500));
    }

    if (newlyFlagged > 0) {
        await sendTelegramMessage(chatId, `🔍 Encontrei ${newlyFlagged} sub(s) adicional(is) que exigem verificação`);
    }

    // Now run the full scan for this model
    await scanForModel({ ...model, phone: String(chatId) });
}
