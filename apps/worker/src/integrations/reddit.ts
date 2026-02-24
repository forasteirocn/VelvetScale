import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { getSupabaseAdmin } from '@velvetscale/db';
import { askClaudeWhatToClick } from './claude';
import * as fs from 'fs';
import * as path from 'path';

// =============================================
// Reddit Browser Automation (Playwright)
// Replaces Reddit API — no approval needed, no NSFW restrictions
// =============================================

const COOKIES_DIR = path.join(process.cwd(), '.reddit-sessions');

// Ensure cookies directory exists
if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

let browser: Browser | null = null;

/**
 * Get or create a shared browser instance
 * Uses a single Chromium instance to save memory (~300MB)
 */
async function getBrowser(): Promise<Browser> {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: false, // Visible browser — so model can see what's happening
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });
    }
    return browser;
}

/**
 * Get a browser context for a specific model's Reddit account
 * Uses saved cookies to maintain login session
 */
async function getModelContext(modelId: string): Promise<BrowserContext> {
    const br = await getBrowser();
    const cookiePath = path.join(COOKIES_DIR, `${modelId}.json`);

    const context = await br.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
    });

    // Load saved cookies if available
    if (fs.existsSync(cookiePath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
        await context.addCookies(cookies);
    }

    return context;
}

/**
 * Save cookies for a model's session after login
 */
async function saveSession(modelId: string, context: BrowserContext): Promise<void> {
    const cookiePath = path.join(COOKIES_DIR, `${modelId}.json`);
    const cookies = await context.cookies();
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
}

// =============================================
// Reddit Login
// =============================================

/**
 * Login to Reddit with username/password
 * Saves the session cookies for future use
 */
export async function loginReddit(
    modelId: string,
    username: string,
    password: string,
    chatId?: number
): Promise<{ success: boolean; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        console.log('🌐 Abrindo Reddit login...');

        // Navigate to Reddit login page
        await page.goto('https://www.reddit.com/login/', { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(5000); // Wait for full page load

        console.log('📄 Página carregada, procurando formulário...');

        // Try to find AND fill the login form
        // Reddit has multiple layouts - try each approach
        const filled = await tryFillLoginForm(page, username, password);

        if (filled) {
            console.log('🔐 Formulário preenchido, fazendo login...');

            // Try clicking submit or pressing Enter
            const submitClicked = await trySubmitForm(page);
            if (!submitClicked) {
                await page.keyboard.press('Enter');
            }

            await page.waitForTimeout(randomDelay(5000, 7000));
        } else {
            // CAPTCHA or unknown page layout
            console.log('⚠️ Formulário não encontrado — possível CAPTCHA');
            console.log('👀 Resolva o CAPTCHA e faça login manualmente no Chrome!');

            // Notify via Telegram if we have chatId
            if (chatId) {
                const { sendTelegramMessage } = await import('./telegram');
                await sendTelegramMessage(chatId,
                    '⚠️ O Reddit pediu CAPTCHA!\n\n' +
                    '👀 Vá até o Mac dedicado e resolva o CAPTCHA na tela do Chrome.\n' +
                    'Depois faça login manualmente.\n\n' +
                    'O bot vai detectar quando você logar (até 2 min).'
                );
            }

            // Wait up to 2 minutes for user to solve CAPTCHA and login manually
            const loggedIn = await waitForManualLogin(page, 120000);

            if (!loggedIn) {
                const screenshotPath = path.join(COOKIES_DIR, `debug_captcha_${Date.now()}.png`);
                await page.screenshot({ path: screenshotPath });
                console.log(`📸 Screenshot: ${screenshotPath}`);
                await page.close();
                return { success: false, error: 'Timeout esperando login manual (2 min)' };
            }
        }

        // Check if login was successful
        const currentUrl = page.url();
        console.log(`📍 URL: ${currentUrl}`);

        if (currentUrl.includes('login') || currentUrl.includes('register')) {
            const screenshotPath = path.join(COOKIES_DIR, `debug_fail_${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath });
            await page.close();
            return { success: false, error: 'Login falhou — credenciais incorretas ou CAPTCHA' };
        }

        // Save session cookies
        await saveSession(modelId, context);

        // Update DB
        const supabase = getSupabaseAdmin();
        await supabase.from('social_accounts').upsert(
            {
                model_id: modelId,
                platform: 'reddit',
                username,
                is_active: true,
            },
            { onConflict: 'model_id,platform' }
        );

        console.log('✅ Login Reddit salvo!');
        await page.close();
        return { success: true };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Reddit login error:', errMsg);
        return { success: false, error: errMsg };
    } finally {
        if (context) await context.close();
    }
}

/**
 * Try to fill the login form with various selectors
 */
async function tryFillLoginForm(page: Page, username: string, password: string): Promise<boolean> {
    const usernameSelectors = [
        '#login-username',
        'input[name="username"]',
        'input[id="loginUsername"]',
        'input[autocomplete="username"]',
        'input[type="text"]',
    ];

    const passwordSelectors = [
        '#login-password',
        'input[name="password"]',
        'input[id="loginPassword"]',
        'input[type="password"]',
    ];

    // Find username field
    for (const sel of usernameSelectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                await el.click();
                await el.fill(username);
                console.log(`  ✅ Username: ${sel}`);

                await page.waitForTimeout(randomDelay(300, 600));

                // Find password field
                for (const pSel of passwordSelectors) {
                    try {
                        const pEl = page.locator(pSel).first();
                        if (await pEl.isVisible({ timeout: 1500 }).catch(() => false)) {
                            await pEl.click();
                            await pEl.fill(password);
                            console.log(`  ✅ Password: ${pSel}`);
                            return true;
                        }
                    } catch { continue; }
                }
            }
        } catch { continue; }
    }

    return false;
}

/**
 * Try to click a submit button
 */
async function trySubmitForm(page: Page): Promise<boolean> {
    const selectors = [
        'button[type="submit"]',
        'button:has-text("Log In")',
        'button:has-text("Sign In")',
        'button:has-text("Entrar")',
    ];

    for (const sel of selectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                await el.click();
                console.log(`  ✅ Submit: ${sel}`);
                return true;
            }
        } catch { continue; }
    }
    return false;
}

/**
 * Wait for the user to manually login (solve CAPTCHA on screen)
 * Polls the URL every 3 seconds to check if we left the login page
 */
async function waitForManualLogin(page: Page, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await page.waitForTimeout(3000);
        const url = page.url();
        if (!url.includes('login') && !url.includes('register') && !url.includes('captcha')) {
            console.log('✅ Login manual detectado!');
            return true;
        }
    }
    return false;
}

// =============================================
// Import Subreddits from Reddit Profile
// =============================================

/**
 * Import subreddits the user is subscribed to on Reddit
 * Called automatically after login
 */
export async function importSubreddits(
    modelId: string
): Promise<{ success: boolean; imported: number; subs: string[]; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        console.log('📋 Importando subreddits...');

        // Go to the user's subreddit list via old Reddit (easier to scrape)
        await page.goto('https://old.reddit.com/subreddits/mine/', {
            waitUntil: 'commit',
            timeout: 30000,
        });
        await page.waitForTimeout(3000);

        // Check if we're logged in
        const loggedIn = await page.locator('.user a').isVisible({ timeout: 3000 }).catch(() => false);
        if (!loggedIn) {
            // Try new Reddit
            await page.goto('https://www.reddit.com/subreddits/', {
                waitUntil: 'commit',
                timeout: 30000,
            });
            await page.waitForTimeout(3000);
        }

        // Scrape subreddit names from the page
        const subNames: string[] = [];

        // Try old Reddit format first
        const oldRedditSubs = await page.locator('.subscription-box .title a.title').allTextContents().catch(() => []);
        if (oldRedditSubs.length > 0) {
            for (const name of oldRedditSubs) {
                const clean = name.replace('/r/', '').replace('r/', '').trim();
                if (clean) subNames.push(clean);
            }
        }

        // Try alternative selectors
        if (subNames.length === 0) {
            // Try extracting from sidebar or subscription list
            const links = await page.locator('a[href*="/r/"]').allTextContents().catch(() => []);
            for (const text of links) {
                const match = text.match(/r\/([a-zA-Z0-9_]+)/);
                if (match && match[1] && match[1].length > 1) {
                    subNames.push(match[1]);
                }
            }
        }

        // Also try scraping from href attributes
        if (subNames.length === 0) {
            const hrefs = await page.locator('a[href*="/r/"]').evaluateAll(
                (els: Element[]) => els.map(el => el.getAttribute('href') || '')
            ).catch(() => []);

            for (const href of hrefs) {
                const match = href.match(/\/r\/([a-zA-Z0-9_]+)/);
                if (match && match[1] && match[1].length > 2) {
                    subNames.push(match[1]);
                }
            }
        }

        // Deduplicate
        const uniqueSubs = [...new Set(subNames)]
            .filter(s => !['all', 'popular', 'random', 'mod', 'friends'].includes(s.toLowerCase()));

        console.log(`📋 Encontrados ${uniqueSubs.length} subreddits`);

        if (uniqueSubs.length === 0) {
            await page.close();
            return { success: true, imported: 0, subs: [] };
        }

        // Save to database
        const supabase = getSupabaseAdmin();
        let imported = 0;

        for (const subName of uniqueSubs) {
            const { error } = await supabase
                .from('subreddits')
                .upsert(
                    {
                        model_id: modelId,
                        name: subName,
                        is_approved: true, // Auto-approve imported subs
                        nsfw: true, // Assume NSFW for now
                    },
                    { onConflict: 'model_id,name' }
                );

            if (!error) imported++;
        }

        console.log(`✅ ${imported} subreddits importados`);
        await page.close();

        return { success: true, imported, subs: uniqueSubs.slice(0, 20) };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Import subreddits error:', errMsg);
        return { success: false, imported: 0, subs: [], error: errMsg };
    } finally {
        if (context) await context.close();
    }
}


// =============================================
// Reddit Posting
// =============================================

/**
 * Submit a text post to a subreddit via browser
 */
export async function submitRedditPost(
    modelId: string,
    subreddit: string,
    title: string,
    body: string,
    isNsfw: boolean = true
): Promise<{ success: boolean; url?: string; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        // Navigate to subreddit submission page
        await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(randomDelay(2000, 3000));

        // Check if logged in (redirect to login means session expired)
        if (page.url().includes('login')) {
            await page.close();
            await context.close();
            return { success: false, error: 'Session expired — need to login again' };
        }

        // Fill title
        const titleInput = page.locator('textarea[placeholder*="Title"], input[placeholder*="Title"], [data-test-id="post-title"] textarea');
        await titleInput.fill(title);
        await page.waitForTimeout(randomDelay(500, 1000));

        // Fill body text
        const bodyInput = page.locator('div[contenteditable="true"], textarea[placeholder*="Text"]').first();
        await bodyInput.click();
        await page.waitForTimeout(randomDelay(300, 500));
        await bodyInput.fill(body);
        await page.waitForTimeout(randomDelay(500, 1000));

        // Mark NSFW if needed
        if (isNsfw) {
            const nsfwButton = page.locator('button:has-text("NSFW"), button:has-text("nsfw")');
            if (await nsfwButton.isVisible()) {
                await nsfwButton.click();
                await page.waitForTimeout(randomDelay(300, 500));
            }
        }

        // Click Post/Submit button
        const submitButton = page.locator('button:has-text("Post"), button:has-text("Submit"), button[type="submit"]').last();
        await submitButton.click();
        await page.waitForTimeout(randomDelay(3000, 5000));

        // Get the post URL
        const postUrl = page.url();

        // Save to database
        const supabase = getSupabaseAdmin();
        await supabase.from('posts').insert({
            model_id: modelId,
            platform: 'reddit',
            post_type: 'post',
            content: `${title}\n\n${body}`,
            subreddit,
            external_url: postUrl,
            status: 'published',
            published_at: new Date().toISOString(),
        });

        await saveSession(modelId, context);
        await page.close();

        return { success: true, url: postUrl };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Reddit post error:', errMsg);
        return { success: false, error: errMsg };
    } finally {
        if (context) await context.close();
    }
}

/**
 * Submit an image post to a subreddit via browser
 * Downloads the image first, then uploads it to Reddit
 * 
 * Uses 4 layers of resilience:
 *  1. Better upload detection (wait for image preview)
 *  2. Longer submit wait + blur/focus validation triggers (30s)
 *  3. Force-enable disabled button as last resort
 *  4. Old Reddit fallback (simple HTML form)
 */
export async function submitRedditImagePost(
    modelId: string,
    subreddit: string,
    title: string,
    imageUrl: string,
    isNsfw: boolean = true
): Promise<{ success: boolean; url?: string; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        // First download the image to a temp file
        const axios = (await import('axios')).default;
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const tempImagePath = path.join(COOKIES_DIR, `temp_${Date.now()}.jpg`);
        fs.writeFileSync(tempImagePath, Buffer.from(imageResponse.data));

        context = await getModelContext(modelId);
        const page = await context.newPage();

        // Try new Reddit first, fall back to old Reddit if submit fails
        const result = await tryNewRedditSubmit(page, subreddit, title, tempImagePath, isNsfw);

        if (result.submitted) {
            // Success on new Reddit
            fs.unlinkSync(tempImagePath);

            const supabase = getSupabaseAdmin();
            await supabase.from('posts').insert({
                model_id: modelId,
                platform: 'reddit',
                post_type: 'image',
                content: title,
                subreddit,
                external_url: result.url,
                status: 'published',
                published_at: new Date().toISOString(),
                metadata: { image_url: imageUrl },
            });

            await saveSession(modelId, context);
            await page.close();
            return { success: true, url: result.url };
        }

        if (result.error === 'login_required') {
            fs.unlinkSync(tempImagePath);
            await page.close();
            return { success: false, error: 'Session expired — need to login again' };
        }

        // ========== FALLBACK: Old Reddit ==========
        console.log('🔄 Tentando old.reddit.com como fallback...');
        const oldResult = await tryOldRedditSubmit(page, subreddit, title, tempImagePath, isNsfw);

        fs.unlinkSync(tempImagePath);

        if (oldResult.submitted) {
            const supabase = getSupabaseAdmin();
            await supabase.from('posts').insert({
                model_id: modelId,
                platform: 'reddit',
                post_type: 'image',
                content: title,
                subreddit,
                external_url: oldResult.url,
                status: 'published',
                published_at: new Date().toISOString(),
                metadata: { image_url: imageUrl },
            });

            await saveSession(modelId, context);
            await page.close();
            return { success: true, url: oldResult.url };
        }

        await saveSession(modelId, context);
        await page.close();
        return { success: false, error: oldResult.errorMsg || 'Post failed on both new and old Reddit. Check debug screenshots.' };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Reddit image post error:', errMsg);
        return { success: false, error: errMsg };
    } finally {
        if (context) await context.close();
    }
}

/**
 * Attempt to submit image post on new Reddit (www.reddit.com)
 */
async function tryNewRedditSubmit(
    page: Page,
    subreddit: string,
    title: string,
    tempImagePath: string,
    isNsfw: boolean
): Promise<{ submitted: boolean; url?: string; error?: string }> {
    // Navigate to subreddit submission page and wait for stability
    await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for page stability — network idle means no pending requests
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(randomDelay(2000, 3000));

    // Check if logged in
    if (page.url().includes('login')) {
        return { submitted: false, error: 'login_required' };
    }

    // ======== CHECK FOR MODALS / ERRORS ========
    // Detect private/restricted community, banned, or other blocking modals
    console.log('🔍 Checking for blocking modals...');
    const pageText = await page.textContent('body').catch(() => '') || '';
    const pageTextLower = pageText.toLowerCase();

    // === HARD BLOCKS (auto-ban, no recovery) ===
    const hardBlockPatterns = [
        { pattern: 'you are banned', error: 'banned_from_sub' },
        { pattern: 'you have been banned', error: 'banned_from_sub' },
        { pattern: 'you aren\'t allowed to post', error: 'not_allowed' },
        { pattern: 'you aren\'t eligible to post', error: 'not_allowed' },
    ];

    for (const { pattern, error } of hardBlockPatterns) {
        if (pageTextLower.includes(pattern)) {
            console.log(`  🚫 Hard block: ${error} (detected "${pattern}")`);
            try {
                const supabase = (await import('@velvetscale/db')).getSupabaseAdmin();
                await supabase.from('subreddits').update({ is_banned: true }).eq('name', subreddit);
                console.log(`  🛡️ Auto-banned r/${subreddit} in DB`);
            } catch { /* ignore */ }
            return { submitted: false, error: `r/${subreddit}: ${error}` };
        }
    }

    // === PRIVATE/RESTRICTED COMMUNITY — TRY TO JOIN ===
    const privatePatterns = [
        'comunidade é privada', 'community is private', 'this community is private',
        'apenas os membros aprovados', 'only approved members',
        'comunidade é restrita', 'community is restricted',
        'pedir para aderir', 'request to join',
    ];

    const isPrivate = privatePatterns.some(p => pageTextLower.includes(p));

    if (isPrivate) {
        console.log(`  🔐 Private/restricted community detected: r/${subreddit}`);
        console.log(`  🧠 Generating smart join request with Claude...`);

        // Look for the join request text area — Reddit uses various DOM structures
        const joinFormSelectors = [
            // Direct modal content
            'div[role="dialog"] textarea',
            'div[role="dialog"] div[contenteditable="true"]',
            'div[role="dialog"] input[type="text"]',
            // Shreddit components
            'shreddit-modal textarea',
            'shreddit-modal div[contenteditable="true"]',
            // Generic modal
            'div[class*="modal"] textarea',
            'div[class*="modal"] div[contenteditable="true"]',
            // Page-level textarea (some modals render outside dialog)
            'textarea[placeholder*="aderir"]',
            'textarea[placeholder*="join"]',
            'textarea[placeholder*="request"]',
            'textarea[placeholder*="message"]',
            // Fallback — any visible textarea on the page
            'textarea',
        ];

        let joinTextArea = null;
        for (const sel of joinFormSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                    joinTextArea = el;
                    console.log(`  ✅ Found join form: ${sel}`);
                    break;
                }
            } catch { continue; }
        }

        const hasJoinForm = joinTextArea !== null;

        if (hasJoinForm && joinTextArea) {
            try {
                // Get model info for context
                const supabase = (await import('@velvetscale/db')).getSupabaseAdmin();
                const Anthropic = (await import('@anthropic-ai/sdk')).default;
                const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

                // Generate a compelling join request
                const response = await anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 200,
                    system: `You are helping a Reddit content creator join r/${subreddit}.
Write a SHORT, genuine message to request access to this private/restricted subreddit.

RULES:
- Be genuine and friendly, not desperate
- Mention you're an active Reddit user who wants to participate
- If the sub name suggests a niche (e.g. "braziliangirls", "latinas"), subtly show you fit
- Keep it 2-3 sentences max
- In English
- Do NOT mention OnlyFans or any paid content
- Sound like a real person, not a bot
- Be respectful of the community

Example: "Hey! I'm an active content creator and I'd love to be part of this community. I think my content fits well here and I'm happy to follow all the rules. Thanks for considering!"`,
                    messages: [{
                        role: 'user',
                        content: `Write a join request for r/${subreddit}. Keep it short and genuine.`,
                    }],
                });

                const joinMessage = response.content[0].type === 'text'
                    ? response.content[0].text.trim()
                    : 'Hi! I would love to join this community and contribute. Thanks for considering!';

                console.log(`  ✍️ Join request: "${joinMessage.substring(0, 80)}..."`);

                // Fill in the join request
                await joinTextArea.click();
                await page.waitForTimeout(500);
                await joinTextArea.fill(joinMessage);
                await page.waitForTimeout(500);

                // Find and click the submit/send button
                const submitSelectors = [
                    'button:has-text("Enviar pedido")',
                    'button:has-text("Send request")',
                    'button:has-text("Submit")',
                    'button:has-text("Enviar")',
                    'button:has-text("Request")',
                    'button:has-text("Join")',
                ];

                let submitted = false;
                for (const sel of submitSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                        const isDisabled = await btn.isDisabled().catch(() => false);
                        if (!isDisabled) {
                            await btn.click();
                            submitted = true;
                            console.log(`  ✅ Join request submitted for r/${subreddit}!`);
                            break;
                        }
                    }
                }

                if (!submitted) {
                    console.log(`  ⚠️ Could not find submit button for join request`);
                }

                // Mark sub as pending (not banned, just waiting for approval)
                await supabase
                    .from('subreddits')
                    .update({
                        posting_rules: {
                            join_requested: true,
                            join_requested_at: new Date().toISOString(),
                            join_message: joinMessage,
                        },
                    })
                    .eq('name', subreddit);

                // Check if verification photos might be needed
                const needsVerification = pageTextLower.includes('verif') ||
                    pageTextLower.includes('foto') ||
                    pageTextLower.includes('photo') ||
                    pageTextLower.includes('paper') ||
                    pageTextLower.includes('papel') ||
                    pageTextLower.includes('handwritten');

                // Notify model via Telegram
                const { data: model } = await supabase
                    .from('models')
                    .select('phone')
                    .limit(1)
                    .single();

                if (model?.phone) {
                    const safeSub = subreddit.replace(/_/g, '\\_');
                    let telegramMsg = `🔐 r/${safeSub} é uma comunidade privada!\n\n` +
                        `✅ Enviamos um pedido de acesso automaticamente.\n` +
                        `📝 Mensagem: "${joinMessage.substring(0, 100)}"`;

                    if (needsVerification) {
                        telegramMsg += `\n\n⚠️ Esse sub pode pedir verificação com foto.\n` +
                            `Se precisar, envie aqui a foto de verificação (nome do user escrito em papel).`;
                    }

                    telegramMsg += `\n\nQuando for aceita, eu posto automaticamente!`;

                    const { sendTelegramMessage } = await import('./telegram');
                    await sendTelegramMessage(Number(model.phone), telegramMsg);
                }

            } catch (err) {
                console.error('  ⚠️ Join request error:', err instanceof Error ? err.message : err);
            }
        } else {
            console.log(`  ⚠️ No join form found on private community page`);
        }

        return { submitted: false, error: `r/${subreddit}: private community (join request sent)` };
    }

    // Also check for modal dialogs with blocking content
    const modalSelectors = [
        'div[role="dialog"]',
        'div[class*="modal"]',
        'shreddit-modal',
        '[data-testid="modal"]',
    ];

    for (const sel of modalSelectors) {
        try {
            const modal = page.locator(sel).first();
            if (await modal.isVisible({ timeout: 1000 }).catch(() => false)) {
                const modalText = await modal.textContent().catch(() => '') || '';
                const modalLower = modalText.toLowerCase();

                // Check if it's a private/restricted modal
                if (modalLower.includes('privad') || modalLower.includes('private') ||
                    modalLower.includes('restri') || modalLower.includes('aderir') ||
                    modalLower.includes('join')) {

                    // Try to fill join request in modal too
                    const modalTextArea = modal.locator('textarea, div[contenteditable="true"], input[type="text"]').first();
                    if (await modalTextArea.isVisible({ timeout: 1000 }).catch(() => false)) {
                        try {
                            const Anthropic = (await import('@anthropic-ai/sdk')).default;
                            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
                            const resp = await anthropic.messages.create({
                                model: 'claude-sonnet-4-20250514',
                                max_tokens: 100,
                                messages: [{ role: 'user', content: `Write a 2-sentence join request for r/${subreddit}. Be genuine, no mentions of paid content.` }],
                            });
                            const msg = resp.content[0].type === 'text' ? resp.content[0].text.trim() : 'I would love to join this community!';

                            await modalTextArea.click();
                            await modalTextArea.fill(msg);
                            await page.waitForTimeout(500);

                            // Try submit
                            const submitBtn = modal.locator('button:has-text("Enviar"), button:has-text("Submit"), button:has-text("Send"), button:has-text("Request")').first();
                            if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                                await submitBtn.click();
                                console.log(`  ✅ Join request submitted via modal for r/${subreddit}`);
                            }
                        } catch { /* ignore */ }
                    }

                    // Close modal
                    const closeBtn = modal.locator('button:has-text("Ir para"), button:has-text("Go"), button:has-text("Close"), button[aria-label="close"]').first();
                    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                        await closeBtn.click();
                    }

                    return { submitted: false, error: `r/${subreddit}: private community (join request sent)` };
                }

                // Check for banned
                if (modalLower.includes('banned')) {
                    try {
                        const supabase = (await import('@velvetscale/db')).getSupabaseAdmin();
                        await supabase.from('subreddits').update({ is_banned: true }).eq('name', subreddit);
                    } catch { /* ignore */ }
                    return { submitted: false, error: `r/${subreddit}: banned` };
                }
            }
        } catch { continue; }
    }

    console.log('  ✅ No blocking modals detected');

    // Switch to "Images & Video" tab
    console.log('📷 Selecionando aba de imagem...');
    const imageTabSelectors = [
        'button[role="tab"][data-select-value="IMAGE"]',
        'faceplate-tab[panel-id="IMAGE"]',
        'button:has-text("Images")',
        'button:has-text("Imagens")',
    ];
    for (const sel of imageTabSelectors) {
        try {
            const tab = page.locator(sel).first();
            if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
                await tab.click();
                console.log(`  ✅ Image tab: ${sel}`);
                break;
            }
        } catch { continue; }
    }
    await page.waitForTimeout(1000);

    // Upload image via file input
    console.log('📤 Uploading imagem...');
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(tempImagePath);

    // ======== IMPROVED: Wait for image upload to complete ========
    console.log('  ⏳ Aguardando upload completo...');
    await page.waitForTimeout(3000); // Initial wait

    // Wait for upload preview to appear (up to 30s)
    const uploadCompleteSelectors = [
        'img[src*="preview.redd.it"]',
        'img[src*="i.redd.it"]',
        'img[src*="redditmedia"]',
        'div[data-testid="image-preview"] img',
        'faceplate-img[src*="redd"]',
        // Thumbnail/preview container
        'div[class*="thumbnail"] img',
        'div[class*="preview"] img',
    ];

    let uploadConfirmed = false;
    for (let attempt = 0; attempt < 15; attempt++) {
        // Check for preview image
        for (const sel of uploadCompleteSelectors) {
            try {
                if (await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log(`  ✅ Upload confirmed via: ${sel}`);
                    uploadConfirmed = true;
                    break;
                }
            } catch { continue; }
        }
        if (uploadConfirmed) break;

        // Also check: if no spinner/progress visible and file input changed, consider done
        const hasSpinner = await page.locator('[class*="upload"], [class*="progress"], [class*="loading"], [class*="spinner"]')
            .isVisible({ timeout: 500 }).catch(() => false);
        if (!hasSpinner && attempt >= 3) {
            console.log('  ✅ No upload indicator visible, assuming complete');
            uploadConfirmed = true;
            break;
        }

        await page.waitForTimeout(2000);
        console.log(`  ⏳ Upload em progresso... (${attempt + 1}/15)`);
    }

    if (!uploadConfirmed) {
        console.log('  ⚠️ Upload may not have completed, proceeding anyway...');
    }

    // Fill title — try multiple selectors
    console.log('📝 Preenchendo título...');
    const titleSelectors = [
        'textarea[slot="title"]',
        'textarea[name="title"]',
        'textarea[placeholder*="Title"]',
        'textarea[placeholder*="Título"]',
        'input[placeholder*="Title"]',
        '[data-test-id="post-title"] textarea',
        'div[contenteditable="true"]',
    ];
    let titleFilled = false;
    for (const sel of titleSelectors) {
        try {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
                await input.click();
                await input.fill(title);
                titleFilled = true;
                console.log(`  ✅ Title filled via: ${sel}`);
                break;
            }
        } catch { continue; }
    }
    if (!titleFilled) {
        console.log('  ⚠️ Could not find title input, trying keyboard approach...');
        await page.keyboard.press('Tab');
        await page.keyboard.type(title, { delay: 30 });
    }
    await page.waitForTimeout(1000);

    // ======== IMPROVED: Trigger form validation via blur events ========
    console.log('  🔄 Triggering form validation...');
    await page.evaluate(() => {
        // Blur all inputs/textareas to trigger validation
        document.querySelectorAll('textarea, input').forEach(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
    });
    await page.waitForTimeout(500);

    // Mark NSFW
    if (isNsfw) {
        console.log('🔞 Marcando NSFW...');
        const nsfwSelectors = [
            'button:has-text("NSFW")',
            'faceplate-switch[input-name="nsfw"]',
            'button[aria-label*="NSFW"]',
            'button[aria-label*="nsfw"]',
        ];
        for (const sel of nsfwSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await btn.click();
                    console.log(`  ✅ NSFW via: ${sel}`);
                    break;
                }
            } catch { continue; }
        }
    }

    // Try to set flair if needed (some subs require it)
    console.log('🏷️ Verificando flair...');

    /**
     * Vision-guided flair selection — Claude sees the screen and tells us what to click
     */
    async function trySelectFlairWithVision(): Promise<boolean> {
        const result = await askClaudeWhatToClick(
            page,
            'I am on a Reddit post submission page. Is there a flair picker or "Add flair" button visible? If yes, tell me the exact text to click to open it. If flair is already selected or not required, say action "none".'
        );

        if (result.action === 'none') {
            console.log('  ℹ️ Claude says no flair needed');
            return false;
        }

        if (result.target) {
            console.log(`  🏷️ Claude says click: "${result.target}"`);
            try {
                // Try getByText first, then locator
                let clicked = false;
                const target = page.getByText(result.target, { exact: false }).first();
                if (await target.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await target.click();
                    clicked = true;
                }
                if (!clicked) {
                    const alt = page.locator(`text="${result.target}"`).first();
                    if (await alt.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await alt.click();
                        clicked = true;
                    }
                }
                if (!clicked) {
                    // JS fallback
                    await page.evaluate((t: string) => {
                        for (const el of document.querySelectorAll('button, div, span, a, [role="button"]')) {
                            if ((el.textContent || '').trim().toLowerCase().includes(t.toLowerCase()) && (el as HTMLElement).offsetHeight > 0) {
                                (el as HTMLElement).click();
                                return;
                            }
                        }
                    }, result.target);
                    clicked = true;
                }

                await page.waitForTimeout(2000);
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
                console.log(`  ✅ Flair picker opened`);
            } catch {
                console.log(`  ⚠️ Could not click "${result.target}"`);
                return false;
            }
        }

        // Now screenshot the flair options and ask Claude which one to pick
        const optionResult = await askClaudeWhatToClick(
            page,
            'I opened a flair picker on Reddit. I see flair options (possibly in a modal/dialog). Pick a safe, generic flair for a NSFW photo post. Tell me the EXACT text of the flair to click. List ALL available in allOptions.'
        );

        if (optionResult.action === 'none' || !optionResult.target) {
            console.log('  ⚠️ Claude could not find flair options');
            await page.keyboard.press('Escape').catch(() => { });
            return false;
        }

        console.log(`  🏷️ Selecting flair: "${optionResult.target}"`);
        if (optionResult.allOptions?.length) {
            console.log(`  📋 Available: ${optionResult.allOptions.join(', ')}`);
        }

        // Click the flair option — multiple aggressive strategies
        const targetText = optionResult.target;
        let picked = false;

        // Strategy 1: Playwright page.click with text selector (best for shadow DOM)
        if (!picked) {
            try {
                await page.click(`text="${targetText}"`, { timeout: 3000, force: true });
                picked = true;
                console.log(`  ✅ Flair clicked via page.click text="${targetText}"`);
            } catch { /* continue */ }
        }

        // Strategy 2: getByText with force
        if (!picked) {
            try {
                await page.getByText(targetText, { exact: false }).first().click({ force: true, timeout: 3000 });
                picked = true;
                console.log(`  ✅ Flair clicked via getByText`);
            } catch { /* continue */ }
        }

        // Strategy 3: getByRole option/radio
        if (!picked) {
            try {
                await page.getByRole('option', { name: targetText }).first().click({ force: true, timeout: 2000 });
                picked = true;
                console.log(`  ✅ Flair clicked via getByRole option`);
            } catch {
                try {
                    await page.getByRole('radio', { name: targetText }).first().click({ force: true, timeout: 2000 });
                    picked = true;
                    console.log(`  ✅ Flair clicked via getByRole radio`);
                } catch { /* continue */ }
            }
        }

        // Strategy 4: Deep shadow DOM traversal
        if (!picked) {
            try {
                picked = await page.evaluate((text: string) => {
                    function searchShadowDOM(root: Document | ShadowRoot | Element): boolean {
                        const elements = root.querySelectorAll('li, label, span, div, button, [role="option"], [role="radio"]');
                        for (const el of elements) {
                            const t = (el.textContent || '').trim();
                            if (t === text || (t.includes(text) && t.length < text.length + 20)) {
                                (el as HTMLElement).click();
                                return true;
                            }
                        }
                        // Search inside shadow roots
                        const allElements = root.querySelectorAll('*');
                        for (const el of allElements) {
                            if ((el as HTMLElement).shadowRoot) {
                                if (searchShadowDOM((el as HTMLElement).shadowRoot!)) return true;
                            }
                        }
                        return false;
                    }
                    return searchShadowDOM(document);
                }, targetText);
                if (picked) console.log(`  ✅ Flair clicked via shadow DOM traversal`);
            } catch { /* continue */ }
        }

        // Strategy 5: XPath text match
        if (!picked) {
            try {
                const xpathEl = page.locator(`//*[contains(text(), "${targetText}")]`).first();
                if (await xpathEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await xpathEl.click({ force: true });
                    picked = true;
                    console.log(`  ✅ Flair clicked via XPath`);
                }
            } catch { /* continue */ }
        }

        if (picked) {
            console.log(`  ✅ Flair "${targetText}" selected`);
            await page.waitForTimeout(1500);

            // Check for Apply/Save button
            const applyResult = await askClaudeWhatToClick(
                page,
                'I selected a flair in a modal. Is there an "Apply", "Save" or "Done" button? Tell me the exact text. If modal closed, say "none".'
            );

            if (applyResult.action !== 'none' && applyResult.target) {
                try {
                    await page.click(`text="${applyResult.target}"`, { timeout: 3000, force: true });
                    console.log(`  ✅ Flair applied: "${applyResult.target}"`);
                    await page.waitForTimeout(1000);
                } catch {
                    // Try getByText
                    try {
                        await page.getByText(applyResult.target, { exact: false }).first().click({ force: true, timeout: 2000 });
                        console.log(`  ✅ Flair applied via getByText`);
                        await page.waitForTimeout(1000);
                    } catch { /* ignore */ }
                }
            }
            return true;
        }

        console.log(`  ⚠️ Failed to select flair "${targetText}" with all strategies`);
        await page.keyboard.press('Escape').catch(() => { });
        return false;
    }

    await trySelectFlairWithVision();

    // Debug screenshot before submit
    const debugPath = path.join(COOKIES_DIR, `debug_submit_${Date.now()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`📸 Debug screenshot: ${debugPath}`);

    // Log all buttons for debugging
    const buttonsInfo = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => ({
            text: b.textContent?.trim()?.substring(0, 50),
            type: b.type,
            disabled: b.disabled,
            ariaLabel: b.getAttribute('aria-label'),
        })).filter(b => b.text && b.text.length > 0);
    });
    console.log('  📋 Buttons on page:', JSON.stringify(buttonsInfo.slice(0, 15)));

    // ======== SUBMIT: 3 approaches ========
    console.log('🚀 Procurando botão de submit...');
    let submitted = false;

    // --- Approach 1: Find submit button, wait up to 30s for it to enable ---
    const submitSelectors = [
        'shreddit-composer button[type="submit"]',
        'button[type="submit"]',
        'button:has-text("Post")',
        'button:has-text("Publicar")',
        'button:has-text("Submit")',
    ];

    for (const sel of submitSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                const isDisabled = await btn.isDisabled().catch(() => false);
                if (isDisabled) {
                    console.log(`  ⏳ Submit button found (${sel}) but disabled, waiting up to 30s...`);

                    // Re-trigger validation periodically while waiting
                    for (let i = 0; i < 30; i++) {
                        if (!(await btn.isDisabled().catch(() => true))) break;

                        // At 10 seconds, try selecting flair (most common reason for disabled button)
                        if (i === 10) {
                            console.log('  🏷️ Button still disabled — trying flair selection with Vision...');
                            const flairSelected = await trySelectFlairWithVision();
                            if (flairSelected) {
                                await page.waitForTimeout(1000);
                                if (!(await btn.isDisabled().catch(() => true))) {
                                    console.log('  ✅ Flair fixed the disabled button!');
                                    break;
                                }
                            }
                        }

                        // Every 5 seconds, re-trigger blur/input events on form fields
                        if (i % 5 === 0 && i > 0) {
                            await page.evaluate(() => {
                                document.querySelectorAll('textarea, input').forEach(el => {
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                                });
                            });
                            console.log(`  🔄 Re-triggered validation (${i}s)...`);
                        }
                        await page.waitForTimeout(1000);
                    }
                }

                const stillDisabled = await btn.isDisabled().catch(() => false);
                if (!stillDisabled) {
                    await btn.click({ timeout: 10000 });
                    submitted = true;
                    console.log(`  ✅ Submit via: ${sel}`);
                    break;
                } else {
                    console.log(`  ⚠️ Button still disabled after 30s: ${sel}`);
                }
            }
        } catch (e) {
            console.log(`  ⚠️ ${sel} failed:`, e instanceof Error ? e.message.substring(0, 100) : '');
            continue;
        }
    }

    // --- Approach 2: Force-enable the button, remove disabled attr, and click ---
    if (!submitted) {
        console.log('  🔧 Force-enabling submit button...');
        try {
            const forceResult = await page.evaluate(() => {
                // Try regular DOM first
                const buttons = Array.from(document.querySelectorAll('button'));
                const submit = buttons.find(b => {
                    const text = b.textContent?.trim().toLowerCase() || '';
                    return (text === 'post' || text === 'publicar' || text === 'submit') &&
                        b.type === 'submit';
                });
                if (submit) {
                    submit.disabled = false;
                    submit.removeAttribute('disabled');
                    submit.removeAttribute('aria-disabled');
                    // Also enable any parent form
                    const form = submit.closest('form');
                    if (form) {
                        form.querySelectorAll('[disabled]').forEach(el => {
                            (el as HTMLElement).removeAttribute('disabled');
                        });
                    }
                    submit.click();
                    return 'force-clicked';
                }

                // Try shadow DOM (shreddit-composer)
                const composers = document.querySelectorAll('shreddit-composer, [bundlename*="submit"]');
                for (const comp of Array.from(composers)) {
                    const shadow = (comp as HTMLElement).shadowRoot;
                    if (shadow) {
                        const shadowBtn = shadow.querySelector('button[type="submit"]') as HTMLButtonElement | null;
                        if (shadowBtn) {
                            shadowBtn.disabled = false;
                            shadowBtn.removeAttribute('disabled');
                            shadowBtn.click();
                            return 'shadow-force-clicked';
                        }
                    }
                }

                return 'not-found';
            });
            console.log(`  🔧 Force result: ${forceResult}`);
            if (forceResult.includes('clicked')) submitted = true;
        } catch (e) {
            console.error('  ❌ Force-enable failed:', e);
        }
    }

    // --- Approach 3: Try submitting form directly ---
    if (!submitted) {
        console.log('  🔧 Trying direct form submission...');
        try {
            const formResult = await page.evaluate(() => {
                const forms = document.querySelectorAll('form');
                for (const form of Array.from(forms)) {
                    const submitBtn = form.querySelector('button[type="submit"]');
                    if (submitBtn) {
                        // Disable all validation
                        form.setAttribute('novalidate', '');
                        // Remove disabled from submit button
                        (submitBtn as HTMLButtonElement).disabled = false;
                        submitBtn.removeAttribute('disabled');
                        // Try requestSubmit (native form submission)
                        try {
                            form.requestSubmit();
                            return 'requestSubmit-ok';
                        } catch {
                            // Fallback: click submit
                            (submitBtn as HTMLButtonElement).click();
                            return 'form-submit-click';
                        }
                    }
                }
                return 'no-form-found';
            });
            console.log(`  🔧 Form result: ${formResult}`);
            if (formResult !== 'no-form-found') submitted = true;
        } catch (e) {
            console.error('  ❌ Form submission failed:', e);
        }
    }

    // Check for validation errors
    if (!submitted) {
        const errorText = await page.evaluate(() => {
            const errors = document.querySelectorAll('[class*="error" i], [class*="Error"], [role="alert"]');
            return Array.from(errors).map(e => e.textContent?.trim()).filter(Boolean).join('; ');
        });
        if (errorText) {
            console.log(`  ❌ Form errors: ${errorText}`);
        }
    }

    // ======== Handle ANY MODAL after submit (flair, confirmation, errors) ========
    // Uses Claude Vision to see what's on screen and decide what to click
    await page.waitForTimeout(2000);
    console.log('  🔍 Checking for post-submit modals with Vision...');

    try {
        // Check if there's any visible modal/dialog on screen
        const hasModal = await page.evaluate(() => {
            const modals = document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], div[class*="modal"], div[class*="overlay"]');
            for (const m of modals) {
                if ((m as HTMLElement).offsetHeight > 0) return true;
            }
            return false;
        });

        if (hasModal) {
            console.log('  🔍 Modal detected! Asking Claude Vision...');

            const modalResult = await askClaudeWhatToClick(
                page,
                'I just clicked "Post" on Reddit and a modal/dialog appeared. What is this modal about? If it\'s a flair selection, pick a safe generic flair. If it\'s a confirmation, tell me which button to click. Tell me the EXACT text of what I should click.'
            );

            if (modalResult.action !== 'none' && modalResult.target) {
                console.log(`  🧠 Modal action: click "${modalResult.target}"`);

                // Try clicking what Claude said
                let modalClicked = false;
                const modalTarget = page.getByText(modalResult.target, { exact: false }).first();
                if (await modalTarget.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await modalTarget.click();
                    modalClicked = true;
                }

                if (!modalClicked) {
                    // JS fallback
                    modalClicked = await page.evaluate((text: string) => {
                        for (const el of document.querySelectorAll('button, li, label, [role="option"], [role="radio"], a, span, div')) {
                            const t = (el.textContent || '').trim();
                            if ((t === text || t.includes(text)) && (el as HTMLElement).offsetHeight > 0) {
                                (el as HTMLElement).click();
                                return true;
                            }
                        }
                        return false;
                    }, modalResult.target);
                }

                if (modalClicked) {
                    console.log(`  ✅ Modal handled: "${modalResult.target}"`);
                    await page.waitForTimeout(1500);

                    // Check if there's an Apply/Save button
                    const followUp = await askClaudeWhatToClick(
                        page,
                        'After clicking an option in a Reddit modal, is there a confirmation button like "Apply", "Save", "Done", or "Post" visible? Tell me its exact text. If no modal visible, say "none".'
                    );

                    if (followUp.action !== 'none' && followUp.target) {
                        const followBtn = page.getByText(followUp.target, { exact: false }).first();
                        if (await followBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                            await followBtn.click();
                            console.log(`  ✅ Follow-up click: "${followUp.target}"`);
                            await page.waitForTimeout(1500);
                            submitted = true;
                        }
                    }

                    // Re-click Post if needed
                    if (!submitted) {
                        for (const sel of submitSelectors) {
                            try {
                                const btn = page.locator(sel).first();
                                if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                                    if (!(await btn.isDisabled().catch(() => false))) {
                                        await btn.click({ timeout: 5000 });
                                        submitted = true;
                                        console.log(`  ✅ Re-submitted after modal: ${sel}`);
                                        break;
                                    }
                                }
                            } catch { continue; }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.log('  ℹ️ Post-submit modal check error:', err instanceof Error ? err.message.substring(0, 50) : '');
    }

    // ======== Handle NSFW confirmation modal ========
    // Reddit shows a modal warning about NSFW content after clicking Post
    // We need to confirm it to actually submit
    await page.waitForTimeout(2000);
    console.log('  🔍 Checking for NSFW confirmation modal...');

    const nsfwModalSelectors = [
        // Common modal confirm buttons
        'dialog button:has-text("Yes")',
        'dialog button:has-text("Continue")',
        'dialog button:has-text("Confirm")',
        'dialog button:has-text("Post")',
        'dialog button:has-text("Sim")',
        'dialog button:has-text("Continuar")',
        'dialog button:has-text("Confirmar")',
        // Reddit-specific modal selectors
        '[role="dialog"] button:has-text("Yes")',
        '[role="dialog"] button:has-text("Continue")',
        '[role="dialog"] button:has-text("Confirm")',
        '[role="dialog"] button:has-text("Post")',
        '[role="alertdialog"] button:has-text("Yes")',
        '[role="alertdialog"] button:has-text("Continue")',
        '[role="alertdialog"] button:has-text("Confirm")',
        // Generic modal overlays
        '.modal button:has-text("Yes")',
        '.modal button:has-text("Continue")',
        '.modal button:has-text("Confirm")',
        '.modal button:has-text("Post")',
        // Shreddit overlay components
        'shreddit-async-loader button:has-text("Yes")',
        'shreddit-async-loader button:has-text("Continue")',
        'shreddit-async-loader button:has-text("Post")',
    ];

    for (const sel of nsfwModalSelectors) {
        try {
            const modalBtn = page.locator(sel).first();
            if (await modalBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await modalBtn.click();
                console.log(`  ✅ NSFW modal confirmed via: ${sel}`);
                await page.waitForTimeout(2000);
                break;
            }
        } catch { continue; }
    }

    // Also try JS approach for modals that may be in shadow DOM or hard to select
    try {
        const modalResult = await page.evaluate(() => {
            // Find any visible dialog/modal overlay
            const dialogs = document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"]');
            for (const dialog of Array.from(dialogs)) {
                if (!(dialog as HTMLElement).offsetParent && !(dialog as HTMLDialogElement).open) continue;
                const buttons = dialog.querySelectorAll('button');
                for (const btn of Array.from(buttons)) {
                    const text = btn.textContent?.trim().toLowerCase() || '';
                    if (['yes', 'continue', 'confirm', 'post', 'sim', 'continuar', 'confirmar', 'ok'].includes(text)) {
                        (btn as HTMLButtonElement).click();
                        return `modal-confirmed: ${text}`;
                    }
                }
            }
            return 'no-modal';
        });
        if (modalResult !== 'no-modal') {
            console.log(`  ✅ ${modalResult}`);
            await page.waitForTimeout(2000);
        }
    } catch { /* no modal */ }

    await page.waitForTimeout(2000);

    // Wait for URL to change from submit page to actual post
    let postUrl = page.url();

    if (postUrl.includes('/submit')) {
        console.log('  ⏳ Waiting for redirect after submit...');
        try {
            await page.waitForURL((url) => !url.toString().includes('/submit'), { timeout: 30000 });
            postUrl = page.url();
            console.log(`  ✅ Redirected to: ${postUrl}`);
        } catch {
            const afterPath = path.join(COOKIES_DIR, `debug_after_submit_${Date.now()}.png`);
            await page.screenshot({ path: afterPath });
            console.log(`  ⚠️ No redirect after 30s. Screenshot: ${afterPath}`);
            console.log(`  Current URL: ${page.url()}`);
            postUrl = page.url();
        }
    }

    await page.waitForTimeout(2000);

    // Verify if post was actually created
    const postSuccess = postUrl.includes('/comments/') || (postUrl.includes('/r/') && !postUrl.includes('/submit'));

    if (postSuccess) {
        return { submitted: true, url: postUrl };
    }

    return { submitted: false, error: 'new_reddit_failed' };
}

/**
 * Fallback: Submit image post via old.reddit.com
 * Old Reddit uses a simple HTML form — no shadow DOM, no fancy components
 */
async function tryOldRedditSubmit(
    page: Page,
    subreddit: string,
    title: string,
    tempImagePath: string,
    isNsfw: boolean
): Promise<{ submitted: boolean; url?: string; errorMsg?: string }> {
    try {
        // Navigate to old Reddit submit page
        await page.goto(`https://old.reddit.com/r/${subreddit}/submit`, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(randomDelay(3000, 5000));

        // Check if logged in on old Reddit
        const loggedIn = await page.locator('.user a').isVisible({ timeout: 3000 }).catch(() => false);
        if (!loggedIn) {
            console.log('  ⚠️ Not logged in on old Reddit');
            return { submitted: false, errorMsg: 'Not logged in on old.reddit.com' };
        }

        // Click the "image" or "link" tab (old Reddit uses tabs)
        const linkTab = page.locator('a[href*="submit"], .submit-link, ul.tabmenu li a').filter({ hasText: /image|link|imagem/i }).first();
        if (await linkTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await linkTab.click();
            await page.waitForTimeout(1000);
        }

        // Try to find and use file upload (old Reddit may support it via drag-drop or input)
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(tempImagePath);
            console.log('  ✅ File uploaded on old Reddit');
            await page.waitForTimeout(5000);
        } else {
            console.log('  ⚠️ No file input found on old Reddit — trying image URL approach');
            // Old Reddit typically accepts URLs, not file uploads for images
            // We'd need to upload the image to imgur first, which is complex
            // For now, return failure so the error is reported
            return { submitted: false, errorMsg: 'Old Reddit does not support direct file upload' };
        }

        // Fill title
        const titleInput = page.locator('[name="title"], #title-field textarea, textarea[name="title"]').first();
        if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await titleInput.fill(title);
            console.log('  ✅ Title filled on old Reddit');
        }

        // Mark NSFW if supported
        if (isNsfw) {
            const nsfwCheckbox = page.locator('input[name="over_18"], input#over18, label:has-text("NSFW") input').first();
            if (await nsfwCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
                await nsfwCheckbox.check();
                console.log('  ✅ NSFW checked on old Reddit');
            }
        }

        // Submit
        const submitBtn = page.locator('button[type="submit"]:has-text("submit"), button[type="submit"]:has-text("post"), #submit_btn, .submit button').first();
        if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await submitBtn.click();
            console.log('  🚀 Clicked submit on old Reddit');
        } else {
            // Try pressing Enter
            await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(3000);

        // Wait for redirect
        let postUrl = page.url();
        if (postUrl.includes('/submit')) {
            try {
                await page.waitForURL((url) => !url.toString().includes('/submit'), { timeout: 30000 });
                postUrl = page.url();
                console.log(`  ✅ Old Reddit redirected to: ${postUrl}`);
            } catch {
                const afterPath = path.join(COOKIES_DIR, `debug_old_reddit_${Date.now()}.png`);
                await page.screenshot({ path: afterPath });
                console.log(`  ⚠️ Old Reddit no redirect. Screenshot: ${afterPath}`);
                return { submitted: false, errorMsg: 'Old Reddit submit did not redirect' };
            }
        }

        const success = postUrl.includes('/comments/') || (postUrl.includes('/r/') && !postUrl.includes('/submit'));
        if (success) {
            return { submitted: true, url: postUrl };
        }

        return { submitted: false, errorMsg: `Old Reddit ended at URL: ${postUrl}` };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('  ❌ Old Reddit fallback error:', errMsg);
        return { submitted: false, errorMsg: errMsg };
    }
}

// =============================================
// Reddit Discovery (via browser search)
// =============================================

/**
 * Search for subreddits by keywords via browser
 */
export async function searchSubreddits(
    modelId: string,
    query: string,
    limit: number = 10
): Promise<Array<{ name: string; subscribers: string; nsfw: boolean; description: string }>> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        await page.goto(`https://www.reddit.com/search/?q=${encodeURIComponent(query)}&type=sr`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(randomDelay(2000, 3000));

        // Extract subreddit results
        const results = await page.evaluate((maxResults: number) => {
            const items: Array<{ name: string; subscribers: string; nsfw: boolean; description: string }> = [];
            const elements = document.querySelectorAll('[data-testid="subreddit-link"], a[href*="/r/"]');

            for (const el of Array.from(elements).slice(0, maxResults)) {
                const href = el.getAttribute('href') || '';
                const match = href.match(/\/r\/([^/]+)/);
                if (match) {
                    items.push({
                        name: match[1],
                        subscribers: el.querySelector('[id*="subscribers"]')?.textContent || 'unknown',
                        nsfw: el.textContent?.toLowerCase().includes('nsfw') || false,
                        description: el.querySelector('p')?.textContent || '',
                    });
                }
            }
            return items;
        }, limit);

        await page.close();
        return results;

    } catch (error) {
        console.error('❌ Reddit search error:', error);
        return [];
    } finally {
        if (context) await context.close();
    }
}

/**
 * Get subreddit info and rules via browser
 */
export async function getSubredditInfo(
    modelId: string,
    subredditName: string
): Promise<{ rules: string[]; subscribers: string; nsfw: boolean } | null> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        await page.goto(`https://www.reddit.com/r/${subredditName}/about/rules`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(randomDelay(2000, 3000));

        const info = await page.evaluate(() => {
            const rules = Array.from(document.querySelectorAll('[data-testid="rule-title"], .rule-title, h3'))
                .map(el => el.textContent?.trim() || '')
                .filter(t => t.length > 0);

            const subscribersEl = document.querySelector('[id*="subscribers"], [data-testid="members-count"]');
            const subscribers = subscribersEl?.textContent || 'unknown';

            const nsfw = document.body.textContent?.toLowerCase().includes('nsfw') || false;

            return { rules, subscribers, nsfw };
        });

        await page.close();
        return info;

    } catch (error) {
        console.error('❌ Reddit subreddit info error:', error);
        return null;
    } finally {
        if (context) await context.close();
    }
}

/**
 * Close the shared browser instance (call on shutdown)
 */
export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

// =============================================
// Utility
// =============================================

/**
 * Generate a random delay to mimic human behavior
 */
function randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
