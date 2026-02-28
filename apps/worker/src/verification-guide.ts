import { getSupabaseAdmin } from '@velvetscale/db';
import { isPlatformEnabled } from '@velvetscale/shared';
import { sendTelegramMessage } from './integrations/telegram';
import { getSubRules } from './anti-ban';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// =============================================
// VelvetScale Verification Guide v2
// 1. Discovers high-value subs (500k+, NSFW, engaged)
// 2. Analyzes verification requirements via Claude
// 3. Checks eligibility (karma, account age)
// 4. Activates Karma Task Force for ineligible subs
// 5. Sends organized Telegram report
// =============================================

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const MIN_MEMBERS = 30_000;

let guideInterval: ReturnType<typeof setInterval> | null = null;

export function startVerificationGuide(): void {
    if (guideInterval) return;

    console.log('🔍 Verification Guide v2 iniciado (diário, executa imediatamente)');

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
// 1. Reddit Account Info
// =============================================

interface RedditAccountInfo {
    username: string;
    totalKarma: number;
    postKarma: number;
    commentKarma: number;
    accountAge: string;
    accountAgeDays: number;
    isVerifiedEmail: boolean;
}

async function getRedditAccountInfo(modelId: string): Promise<RedditAccountInfo | null> {
    try {
        const path = await import('path');
        const fs = await import('fs');
        const cookiePath = path.join(process.cwd(), '.reddit-sessions', `${modelId}.json`);

        if (!fs.existsSync(cookiePath)) return null;

        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
        const cookieStr = cookies
            .filter((c: any) => c.domain?.includes('reddit'))
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');

        const response = await axios.get('https://www.reddit.com/api/me.json', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Cookie': cookieStr,
            },
            timeout: 15000,
        });

        const data = response.data?.data || response.data;
        if (!data?.name) {
            // Fallback: old.reddit.com
            const fb = await axios.get('https://old.reddit.com/api/me.json', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Cookie': cookieStr,
                },
                timeout: 15000,
            });
            const fbData = fb.data?.data || fb.data;
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
    if (ageDays < 30) ageStr = `${ageDays} dias`;
    else if (ageDays < 365) ageStr = `${Math.floor(ageDays / 30)} meses`;
    else {
        const years = Math.floor(ageDays / 365);
        const months = Math.floor((ageDays % 365) / 30);
        ageStr = months > 0 ? `${years}a ${months}m` : `${years} ano(s)`;
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
// 2. Discover high-value subs (500k+, NSFW)
// =============================================

interface DiscoveredSub {
    name: string;
    members: number;
    description: string;
    requiresVerification: boolean;
    isAlreadyAdded: boolean;
}

/**
 * Ask Claude for high-value NSFW subs, then validate via Reddit API
 */
async function discoverHighValueSubs(
    bio: string,
    persona: string,
    existingSubNames: Set<string>
): Promise<DiscoveredSub[]> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 800,
            system: `You are an expert Reddit NSFW marketing strategist.
Suggest 25-30 NSFW subreddits (30k+ members) for adult content creators.

RULES:
- ONLY suggest REAL, active, NSFW subreddits
- Minimum 30,000 members, but the bigger the better
- The sub MUST be actively engaged (daily posts, comments, upvotes)
- Avoid dead/inactive subs even if they have many members
- Focus on: body types, poses, aesthetics, photography niches
- Consider the model's bio and look
- Mix classic big subs (500k+) with mid-size niche subs (30k-500k)
- Niche subs often have BETTER engagement and less competition

Examples: gonewild, RealGirls, ass, booty, thick, curvy, brunette, Nude_Selfie, latinas, fitgirls, BrazilianBabes, tightdresses, yogapants, etc.

Respond with JSON array: [{"name": "SubName"}, ...]
No "r/" prefix. Just the exact sub name.`,
            messages: [{
                role: 'user',
                content: `Bio: ${bio || 'Brazilian model, fit, brunette'}
Persona: ${persona || 'confident, flirty'}
Already in: ${Array.from(existingSubNames).slice(0, 20).join(', ') || 'none'}

Suggest 25-30 NSFW subs (30k+ members, actively engaged) she should be in.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];

        const suggestions: Array<{ name: string }> = JSON.parse(jsonMatch[0]);
        const verified: DiscoveredSub[] = [];

        // Process in batches of 3 for speed (parallel fetches)
        const uniqueSuggestions = suggestions.filter(s => s.name).slice(0, 20);

        for (let i = 0; i < uniqueSuggestions.length && verified.length < 15; i += 3) {
            const batch = uniqueSuggestions.slice(i, i + 3);

            const results = await Promise.allSettled(
                batch.map(async (s) => {
                    const aboutRes = await axios.get(`https://www.reddit.com/r/${s.name}/about.json`, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                        timeout: 8000,
                    });
                    return { name: s.name, data: aboutRes.data?.data };
                })
            );

            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value.data) continue;
                const { name, data } = result.value;
                const members = data.subscribers || 0;
                const isNSFW = data.over18 || false;

                if (members < MIN_MEMBERS || !isNSFW) continue;

                verified.push({
                    name,
                    members,
                    description: (data.public_description || '').substring(0, 200),
                    requiresVerification: false, // Will be checked in guide generation
                    isAlreadyAdded: existingSubNames.has(name.toLowerCase()),
                });
            }

            // Small delay between batches
            await new Promise(r => setTimeout(r, 500));
        }

        return verified.sort((a, b) => b.members - a.members);
    } catch (err) {
        console.error('  ⚠️ Discovery error:', err instanceof Error ? err.message : err);
        return [];
    }
}

// =============================================
// 3. Verification Guide Generation
// =============================================

interface VerificationGuide {
    subName: string;
    members: number;
    steps: string[];
    karmaRequired: number | null;
    accountAgeRequired: string | null;
    verificationLink: string | null;
    difficulty: 'fácil' | 'médio' | 'difícil';
    isEligible: boolean;
    eligibilityReason: string;
}

async function generateVerificationGuide(
    subName: string,
    accountInfo: RedditAccountInfo | null
): Promise<VerificationGuide> {
    let rawRules = '';
    let description = '';
    let members = 0;

    try {
        const [rulesRes, aboutRes] = await Promise.all([
            axios.get(`https://www.reddit.com/r/${subName}/about/rules.json`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                timeout: 10000,
            }).catch(() => ({ data: { rules: [] } })),
            axios.get(`https://www.reddit.com/r/${subName}/about.json`, {
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
        members = aboutData.subscribers || 0;

        // Try verification wiki
        try {
            const wikiRes = await axios.get(`https://www.reddit.com/r/${subName}/wiki/verification.json`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelvetScale/1.0)' },
                timeout: 10000,
            });
            const wikiContent = wikiRes.data?.data?.content_md || '';
            if (wikiContent) {
                rawRules += '\n\n--- VERIFICATION WIKI ---\n' + wikiContent.substring(0, 1500);
            }
        } catch { /* no wiki */ }
    } catch { /* ignore */ }

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            system: `You analyze subreddit verification requirements and create a clear guide.

${accountInfo ? `
User stats:
- Username: u/${accountInfo.username}
- Total karma: ${accountInfo.totalKarma}
- Post karma: ${accountInfo.postKarma}
- Comment karma: ${accountInfo.commentKarma}
- Account age: ${accountInfo.accountAge} (${accountInfo.accountAgeDays} days)
` : ''}

Respond with JSON:
{
  "steps": ["Passo 1: ...", "Passo 2: ..."],
  "karmaRequired": number or null,
  "accountAgeRequired": "string" or null,
  "verificationLink": "URL" or null,
  "difficulty": "fácil" | "médio" | "difícil",
  "isEligible": true/false,
  "eligibilityReason": "reason in Portuguese"
}

IMPORTANT:
- Write ALL steps in Portuguese (Brazilian), be SPECIFIC
- Most NSFW subs require a photo holding paper with sub name + username + date
- Check karma and age against requirements for eligibility
- If no specific karma requirement found, assume eligible`,
            messages: [{
                role: 'user',
                content: `Subreddit: r/${subName}
Description: ${description.substring(0, 400)}
Rules: ${rawRules.substring(0, 2000)}

Generate verification guide in Portuguese.`,
            }],
        });

        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as VerificationGuide;
            parsed.subName = subName;
            parsed.members = members;
            return parsed;
        }
    } catch { /* fallback below */ }

    return {
        subName,
        members,
        steps: [
            'Mande modmail para os moderadores do sub',
            'Inclua foto segurando papel com: nome do sub + seu username + data',
            'Aguarde aprovação (24-72h)',
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
// 4. Main Scan
// =============================================

async function scanVerificationSubs(): Promise<void> {
    console.log('🔍 Verification Guide v2: Scan diário...');
    const supabase = getSupabaseAdmin();

    const { data: models } = await supabase
        .from('models')
        .select('id, phone, bio, persona, enabled_platforms')
        .eq('status', 'active');

    if (!models?.length) return;

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

    // Skip if already sent today
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: alreadySent } = await supabase
        .from('agent_logs')
        .select('*', { count: 'exact', head: true })
        .eq('model_id', model.id)
        .eq('action', 'verification_guide_sent')
        .gte('created_at', todayStart.toISOString());

    if ((alreadySent || 0) > 0) {
        console.log(`  🔍 ${model.id.substring(0, 8)}: Guia já enviado hoje`);
        return;
    }

    // Get subs that need verification
    const { data: verifSubs } = await supabase
        .from('subreddits')
        .select('name, needs_verification, member_count')
        .eq('model_id', model.id)
        .eq('is_approved', true)
        .eq('needs_verification', true);

    if (!verifSubs?.length) {
        console.log(`  🔍 ${model.id.substring(0, 8)}: Nenhum sub pendente de verificação`);
        return;
    }

    // Get account info
    const accountInfo = await getRedditAccountInfo(model.id);
    if (accountInfo) {
        console.log(`  👤 u/${accountInfo.username}: ${accountInfo.totalKarma} karma, ${accountInfo.accountAge}`);
    }

    // Generate guides for verification subs
    const guides: VerificationGuide[] = [];
    for (const sub of verifSubs.slice(0, 8)) {
        console.log(`  📋 Analisando r/${sub.name}...`);
        const guide = await generateVerificationGuide(sub.name, accountInfo);
        guides.push(guide);
        await new Promise(r => setTimeout(r, 2000));
    }

    if (guides.length > 0) {
        // Activate karma priority for ineligible subs
        await activateKarmaForce(model.id, guides.filter(g => !g.isEligible));

        // Send report
        await sendReport(model.phone, accountInfo, guides, []);
    }

    // Log
    await supabase.from('agent_logs').insert({
        model_id: model.id,
        action: 'verification_guide_sent',
        details: {
            subsScanned: guides.length,
            eligible: guides.filter(g => g.isEligible).length,
            karmaForceActivated: guides.filter(g => !g.isEligible).length,
        },
    });
}

// =============================================
// 5. Karma Task Force
// =============================================

async function activateKarmaForce(modelId: string, ineligibleGuides: VerificationGuide[]): Promise<void> {
    if (!ineligibleGuides.length) return;

    const supabase = getSupabaseAdmin();

    for (const guide of ineligibleGuides) {
        // Ensure sub exists in DB
        await supabase.from('subreddits').upsert({
            model_id: modelId,
            name: guide.subName,
            needs_verification: true,
            karma_priority: true,
            member_count: guide.members,
            is_approved: true,
            nsfw: true,
        }, { onConflict: 'model_id,name' });

        console.log(`  🔥 Karma Force ATIVADO para r/${guide.subName}`);
    }
}

// =============================================
// 6. Telegram Report (Beautiful UI)
// =============================================

function formatMembers(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
}

function escTg(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, ' ');
}

async function sendReport(
    chatId: string,
    accountInfo: RedditAccountInfo | null,
    guides: VerificationGuide[],
    discovered: DiscoveredSub[]
): Promise<void> {
    // === MESSAGE 1: Account Stats ===
    let header = '🔐 *VERIFICAÇÃO*\n\n';
    if (accountInfo) {
        header += `👤 u/${escTg(accountInfo.username)}\n`;
        header += `⭐ ${accountInfo.totalKarma.toLocaleString('pt-BR')} karma total\n`;
        header += `📝 ${accountInfo.postKarma.toLocaleString('pt-BR')} post | `;
        header += `💬 ${accountInfo.commentKarma.toLocaleString('pt-BR')} comment\n`;
        header += `📅 Conta: ${accountInfo.accountAge}\n`;
        header += `📧 Email: ${accountInfo.isVerifiedEmail ? 'Verificado ✅' : 'Não verificado ❌'}\n`;
    }
    await sendTelegramMessage(Number(chatId), header);

    // Separate by eligibility
    const ready = guides.filter(g => g.isEligible);
    const needsKarma = guides.filter(g => !g.isEligible);

    // === MESSAGE 2: Ready to verify ===
    if (ready.length > 0) {
        let msg = `━━━ 🟢 *PRONTOS PARA VERIFICAR* (${ready.length}) ━━━\n\n`;
        for (const g of ready) {
            msg += formatGuideMsg(g);
        }
        await sendTelegramMessage(Number(chatId), msg);
    }

    // === MESSAGE 3: Need karma ===
    if (needsKarma.length > 0) {
        let msg = `━━━ 🔴 *PRECISAM DE KARMA* (${needsKarma.length}) ━━━\n\n`;
        for (const g of needsKarma) {
            const safeName = g.subName.replace(/_/g, '\\_');
            msg += `❌ *r/${safeName}* (${formatMembers(g.members)})\n`;

            if (g.karmaRequired && accountInfo) {
                const missing = g.karmaRequired - accountInfo.totalKarma;
                msg += `   ⭐ Karma: ${accountInfo.totalKarma.toLocaleString('pt-BR')} / ${g.karmaRequired.toLocaleString('pt-BR')}`;
                if (missing > 0) msg += ` (faltam ${missing.toLocaleString('pt-BR')})`;
                msg += '\n';
            }
            if (g.accountAgeRequired) {
                msg += `   📅 Idade mínima: ${g.accountAgeRequired}\n`;
            }
            msg += `   🤖 *Karma Builder ativado nesse sub*\n\n`;
        }
        await sendTelegramMessage(Number(chatId), msg);
    }

    // === MESSAGE 4: Discovered subs ===
    if (discovered.length > 0) {
        const newSubs = discovered.filter(d => !d.isAlreadyAdded);
        const existingSubs = discovered.filter(d => d.isAlreadyAdded);

        if (newSubs.length > 0) {
            let msg = `━━━ 🆕 *NOVOS SUBS DESCOBERTOS* (${newSubs.length}) ━━━\n`;
            msg += `(30k\\+ membros, NSFW, engajados)\n\n`;

            for (const d of newSubs) {
                const safeName = d.name.replace(/_/g, '\\_');
                const verifTag = d.requiresVerification ? '🔒 verificação' : '🟢 aberto';
                msg += `📌 *r/${safeName}* (${formatMembers(d.members)}) — ${verifTag}\n`;
            }
            msg += '\nResponda /aprovar para adicionar todos\\.';
            await sendTelegramMessage(Number(chatId), msg);
        }
    }

    // === MESSAGE 5: Summary ===
    const total = guides.length;
    let summary = `📊 *Resumo:* ${ready.length} pronto(s), ${needsKarma.length} precisam karma`;
    if (discovered.filter(d => !d.isAlreadyAdded).length > 0) {
        summary += `, ${discovered.filter(d => !d.isAlreadyAdded).length} novos descobertos`;
    }
    if (needsKarma.length > 0) {
        summary += `\n\n🤖 _Karma Builder focando nos subs que precisam\\. Você será notificada quando estiver elegível\\!_`;
    }
    await sendTelegramMessage(Number(chatId), summary);
}

function formatGuideMsg(guide: VerificationGuide): string {
    const safeName = guide.subName.replace(/_/g, '\\_');
    const diffIcon = guide.difficulty === 'fácil' ? '🟢' : guide.difficulty === 'médio' ? '🟡' : '🔴';

    let msg = `✅ *r/${safeName}* (${formatMembers(guide.members)}) ${diffIcon} ${guide.difficulty}\n`;

    for (let i = 0; i < guide.steps.length; i++) {
        msg += `   ${i + 1}\\. ${escTg(guide.steps[i])}\n`;
    }

    if (guide.verificationLink) {
        msg += `   🔗 ${guide.verificationLink}\n`;
    }

    msg += '\n';
    return msg;
}

// =============================================
// 7. Manual Trigger via /verificar
// =============================================

export async function triggerVerificationGuide(modelId: string, chatId: number): Promise<void> {
    await sendTelegramMessage(chatId, '🔍 Analisando subs e buscando novos de alto valor...');

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

    // 1. Get all existing subs
    const { data: allSubs } = await supabase
        .from('subreddits')
        .select('name, needs_verification, member_count')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('is_banned', false);

    const existingSubNames = new Set((allSubs || []).map(s => s.name.toLowerCase()));

    // 2. Force-scan existing subs for verification (max 10 unchecked, fast)
    const uncheckedSubs = (allSubs || []).filter(s => !s.needs_verification).slice(0, 10);
    let newlyFlagged = 0;

    for (const sub of uncheckedSubs) {
        try {
            const rules = await getSubRules(sub.name);
            if (rules?.requiresVerification) {
                await supabase
                    .from('subreddits')
                    .update({ needs_verification: true })
                    .eq('model_id', modelId)
                    .eq('name', sub.name);
                newlyFlagged++;
            }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 500));
    }

    if (newlyFlagged > 0) {
        await sendTelegramMessage(chatId, `🔒 ${newlyFlagged} sub(s) detectado(s) com verificação obrigatória`);
    }

    // 3. Get account info
    await sendTelegramMessage(chatId, '👤 Buscando dados da sua conta Reddit...');
    const accountInfo = await getRedditAccountInfo(modelId);

    // 4. Discover new high-value subs (30k+, NSFW)
    await sendTelegramMessage(chatId, '🌐 Descobrindo subs de alto valor (30k+ membros, NSFW)...');
    const discovered = await discoverHighValueSubs(
        model.bio || '',
        model.persona || '',
        existingSubNames
    );

    // 5. Add newly discovered subs to DB (unapproved)
    const newlyDiscovered = discovered.filter(d => !d.isAlreadyAdded);
    for (const d of newlyDiscovered) {
        await supabase.from('subreddits').upsert({
            model_id: modelId,
            name: d.name,
            is_approved: false,
            nsfw: true,
            suggested_by_ai: true,
            member_count: d.members,
            needs_verification: d.requiresVerification,
            rules_summary: d.description.substring(0, 200),
        }, { onConflict: 'model_id,name' });
    }

    // 6. Get all subs needing verification (refreshed)
    const { data: verifSubs } = await supabase
        .from('subreddits')
        .select('name, member_count')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('needs_verification', true);

    // 7. Generate guides (max 6 subs for speed, with progress)
    const subsToGuide = (verifSubs || []).slice(0, 6);
    await sendTelegramMessage(chatId, `📋 Gerando guias para ${subsToGuide.length} sub(s)...`);

    const guides: VerificationGuide[] = [];
    for (let i = 0; i < subsToGuide.length; i++) {
        const sub = subsToGuide[i];
        try {
            console.log(`  📋 [${i + 1}/${subsToGuide.length}] Analisando r/${sub.name}...`);
            const guide = await generateVerificationGuide(sub.name, accountInfo);
            guides.push(guide);
        } catch (err) {
            console.error(`  ⚠️ Guide error for r/${sub.name}:`, err instanceof Error ? err.message : err);
            // Add fallback guide so we still show something
            guides.push({
                subName: sub.name,
                members: sub.member_count || 0,
                steps: ['Mande modmail para os moderadores', 'Inclua foto de verificação com username + nome do sub + data'],
                karmaRequired: null,
                accountAgeRequired: null,
                verificationLink: null,
                difficulty: 'médio',
                isEligible: true,
                eligibilityReason: 'Erro ao analisar — verifique manualmente',
            });
        }
        await new Promise(r => setTimeout(r, 800));
    }

    // 8. Activate karma force for ineligible subs
    try {
        const ineligible = guides.filter(g => !g.isEligible);
        await activateKarmaForce(modelId, ineligible);
    } catch (err) {
        console.error('  ⚠️ Karma force error:', err);
    }

    // 9. Send report (wrapped in try/catch to never lose progress)
    try {
        await sendReport(String(chatId), accountInfo, guides, discovered);
    } catch (err) {
        console.error('  ⚠️ Report send error:', err instanceof Error ? err.message : err);
        // Fallback: send a simple summary
        const safeSubs = guides.map(g => `- r/${g.subName.replace(/_/g, '\\_')} (${g.isEligible ? '✅' : '❌'})`).join('\n');
        await sendTelegramMessage(chatId, `📋 *Guias gerados:*\n\n${safeSubs}\n\n_Erro ao formatar relatório completo. Use /verificar novamente._`);
    }

    // 10. Log
    try {
        await supabase.from('agent_logs').insert({
            model_id: modelId,
            action: 'verification_guide_sent',
            details: {
                subsScanned: guides.length,
                eligible: guides.filter(g => g.isEligible).length,
                karmaForce: guides.filter(g => !g.isEligible).length,
                discovered: discovered.length,
                newSubs: newlyDiscovered.length,
            },
        });
    } catch { /* ignore log errors */ }

    console.log(`  ✅ Verification guide sent: ${guides.length} guides, ${discovered.length} discovered`);
}
