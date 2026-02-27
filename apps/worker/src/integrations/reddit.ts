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

if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });
    }
    return browser;
}

export async function getModelContext(modelId: string): Promise<BrowserContext> {
    const br = await getBrowser();
    const cookiePath = path.join(COOKIES_DIR, `${modelId}.json`);

    const context = await br.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
    });

    if (fs.existsSync(cookiePath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
        await context.addCookies(cookies);
    }

    return context;
}

async function saveSession(modelId: string, context: BrowserContext): Promise<void> {
    const cookiePath = path.join(COOKIES_DIR, `${modelId}.json`);
    const cookies = await context.cookies();
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
}

// =============================================
// Reddit Login
// =============================================

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
        await page.goto('https://www.reddit.com/login/', { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(5000);

        console.log('📄 Página carregada, procurando formulário...');
        const filled = await tryFillLoginForm(page, username, password);

        if (filled) {
            console.log('🔐 Formulário preenchido, fazendo login...');
            const submitClicked = await trySubmitForm(page);
            if (!submitClicked) {
                await page.keyboard.press('Enter');
            }
            await page.waitForTimeout(randomDelay(5000, 7000));
        } else {
            console.log('⚠️ Formulário não encontrado — possível CAPTCHA');
            console.log('👀 Resolva o CAPTCHA e faça login manualmente no Chrome!');

            if (chatId) {
                const { sendTelegramMessage } = await import('./telegram');
                await sendTelegramMessage(chatId,
                    '⚠️ O Reddit pediu CAPTCHA!\n\n' +
                    '👀 Vá até o Mac dedicado e resolva o CAPTCHA na tela do Chrome.\n' +
                    'Depois faça login manualmente.\n\n' +
                    'O bot vai detectar quando você logar (até 2 min).'
                );
            }

            const loggedIn = await waitForManualLogin(page, 120000);

            if (!loggedIn) {
                const screenshotPath = path.join(COOKIES_DIR, `debug_captcha_${Date.now()}.png`);
                await page.screenshot({ path: screenshotPath });
                console.log(`📸 Screenshot: ${screenshotPath}`);
                await page.close();
                return { success: false, error: 'Timeout esperando login manual (2 min)' };
            }
        }

        const currentUrl = page.url();
        console.log(`📍 URL: ${currentUrl}`);

        if (currentUrl.includes('login') || currentUrl.includes('register')) {
            const screenshotPath = path.join(COOKIES_DIR, `debug_fail_${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath });
            await page.close();
            return { success: false, error: 'Login falhou — credenciais incorretas ou CAPTCHA' };
        }

        await saveSession(modelId, context);

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

    for (const sel of usernameSelectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                await el.click();
                await el.fill(username);
                console.log(`  ✅ Username: ${sel}`);
                await page.waitForTimeout(randomDelay(300, 600));

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
// Import Subreddits
// =============================================

export async function importSubreddits(
    modelId: string
): Promise<{ success: boolean; imported: number; subs: string[]; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        console.log('📋 Importando subreddits...');
        await page.goto('https://old.reddit.com/subreddits/mine/', { waitUntil: 'commit', timeout: 30000 });
        await page.waitForTimeout(3000);

        const loggedIn = await page.locator('.user a').isVisible({ timeout: 3000 }).catch(() => false);
        if (!loggedIn) {
            await page.goto('https://www.reddit.com/subreddits/', { waitUntil: 'commit', timeout: 30000 });
            await page.waitForTimeout(3000);
        }

        const subNames: string[] = [];

        const oldRedditSubs = await page.locator('.subscription-box .title a.title').allTextContents().catch(() => []);
        if (oldRedditSubs.length > 0) {
            for (const name of oldRedditSubs) {
                const clean = name.replace('/r/', '').replace('r/', '').trim();
                if (clean) subNames.push(clean);
            }
        }

        if (subNames.length === 0) {
            const links = await page.locator('a[href*="/r/"]').allTextContents().catch(() => []);
            for (const text of links) {
                const match = text.match(/r\/([a-zA-Z0-9_]+)/);
                if (match && match[1] && match[1].length > 1) subNames.push(match[1]);
            }
        }

        if (subNames.length === 0) {
            const hrefs = await page.locator('a[href*="/r/"]').evaluateAll(
                (els: Element[]) => els.map(el => el.getAttribute('href') || '')
            ).catch(() => []);
            for (const href of hrefs) {
                const match = href.match(/\/r\/([a-zA-Z0-9_]+)/);
                if (match && match[1] && match[1].length > 2) subNames.push(match[1]);
            }
        }

        const uniqueSubs = [...new Set(subNames)]
            .filter(s => !['all', 'popular', 'random', 'mod', 'friends'].includes(s.toLowerCase()));

        console.log(`📋 Encontrados ${uniqueSubs.length} subreddits`);

        if (uniqueSubs.length === 0) {
            await page.close();
            return { success: true, imported: 0, subs: [] };
        }

        const supabase = getSupabaseAdmin();
        let imported = 0;

        for (const subName of uniqueSubs) {
            const { error } = await supabase.from('subreddits').upsert(
                { model_id: modelId, name: subName, is_approved: true, nsfw: true },
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
// Reddit Posting — Text
// =============================================

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

        await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(randomDelay(2000, 3000));

        if (page.url().includes('login')) {
            await page.close();
            await context.close();
            return { success: false, error: 'Session expired — need to login again' };
        }

        const titleInput = page.locator('textarea[placeholder*="Title"], input[placeholder*="Title"], [data-test-id="post-title"] textarea');
        await titleInput.fill(title);
        await page.waitForTimeout(randomDelay(500, 1000));

        const bodyInput = page.locator('div[contenteditable="true"], textarea[placeholder*="Text"]').first();
        await bodyInput.click();
        await page.waitForTimeout(randomDelay(300, 500));
        await bodyInput.fill(body);
        await page.waitForTimeout(randomDelay(500, 1000));

        if (isNsfw) {
            const nsfwButton = page.locator('button:has-text("NSFW"), button:has-text("nsfw")');
            if (await nsfwButton.isVisible()) {
                await nsfwButton.click();
                await page.waitForTimeout(randomDelay(300, 500));
            }
        }

        const submitButton = page.locator('button:has-text("Post"), button:has-text("Submit"), button[type="submit"]').last();
        await submitButton.click();
        await page.waitForTimeout(randomDelay(3000, 5000));

        const postUrl = page.url();

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

// =============================================
// Reddit Posting — Image (CORRIGIDO)
// =============================================

export async function submitRedditImagePost(
    modelId: string,
    subreddit: string,
    title: string,
    imageUrl: string,
    isNsfw: boolean = true
): Promise<{ success: boolean; url?: string; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        const axios = (await import('axios')).default;
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const tempImagePath = path.join(COOKIES_DIR, `temp_${Date.now()}.jpg`);
        fs.writeFileSync(tempImagePath, Buffer.from(imageResponse.data));

        context = await getModelContext(modelId);
        const page = await context.newPage();

        const result = await tryNewRedditSubmit(page, subreddit, title, tempImagePath, isNsfw);

        if (result.submitted) {
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
        return { success: false, error: oldResult.errorMsg || 'Post failed on both new and old Reddit.' };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Reddit image post error:', errMsg);
        return { success: false, error: errMsg };
    } finally {
        if (context) await context.close();
    }
}

// =============================================
// tryNewRedditSubmit — VERSÃO CORRIGIDA
// Correções:
//   1. Upload via setInputFiles (confiável) em vez de drag-and-drop JS
//   2. Aguarda preview antes de tentar submit
//   3. Flair confirmado DENTRO do modal (não fecha com Escape/click fora)
// =============================================

async function tryNewRedditSubmit(
    page: Page,
    subreddit: string,
    title: string,
    tempImagePath: string,
    isNsfw: boolean
): Promise<{ submitted: boolean; url?: string; error?: string }> {

    await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
    await page.waitForTimeout(randomDelay(2000, 3000));

    if (page.url().includes('login')) {
        return { submitted: false, error: 'login_required' };
    }

    // ======== POLYFILL: define __name in browser context ========
    // tsx/esbuild adds __name() decorator to function declarations during transpilation,
    // but __name only exists at module scope, not in the browser's page.evaluate() context.
    // This no-op polyfill prevents "ReferenceError: __name is not defined" errors.
    await page.evaluate('window.__name = function(fn) { return fn; }');

    // ======== CHECK FOR BLOCKING MODALS ========
    console.log('🔍 Checking for blocking modals...');
    const pageText = await page.textContent('body').catch(() => '') || '';
    const pageTextLower = pageText.toLowerCase();

    const hardBlockPatterns = [
        { pattern: 'you are banned', error: 'banned_from_sub' },
        { pattern: 'you have been banned', error: 'banned_from_sub' },
        { pattern: "you aren't allowed to post", error: 'not_allowed' },
        { pattern: "you aren't eligible to post", error: 'not_allowed' },
    ];

    for (const { pattern, error } of hardBlockPatterns) {
        if (pageTextLower.includes(pattern)) {
            console.log(`  🚫 Hard block: ${error}`);
            try {
                const supabase = (await import('@velvetscale/db')).getSupabaseAdmin();
                await supabase.from('subreddits').update({ is_banned: true }).eq('name', subreddit);
            } catch { /* ignore */ }
            return { submitted: false, error: `r/${subreddit}: ${error}` };
        }
    }

    const privatePatterns = [
        'comunidade é privada', 'community is private', 'this community is private',
        'apenas os membros aprovados', 'only approved members',
        'comunidade é restrita', 'community is restricted',
        'pedir para aderir', 'request to join',
    ];

    const isPrivate = privatePatterns.some(p => pageTextLower.includes(p));
    if (isPrivate) {
        console.log(`  🔐 Private/restricted: r/${subreddit}`);

        const joinFormSelectors = [
            'div[role="dialog"] textarea', 'shreddit-modal textarea',
            'textarea[placeholder*="join"]', 'textarea[placeholder*="request"]',
            'textarea[placeholder*="message"]', 'textarea',
        ];

        let joinTextArea = null;
        for (const sel of joinFormSelectors) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                    joinTextArea = el;
                    break;
                }
            } catch { continue; }
        }

        if (joinTextArea) {
            try {
                const Anthropic = (await import('@anthropic-ai/sdk')).default;
                const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
                const response = await anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 200,
                    messages: [{ role: 'user', content: `Write a short, genuine 2-sentence join request for r/${subreddit}. No mentions of paid content. Sound like a real person.` }],
                });
                const joinMessage = response.content[0].type === 'text' ? response.content[0].text.trim() : 'Hi! I would love to join and contribute to this community.';
                await joinTextArea.click();
                await joinTextArea.fill(joinMessage);
                await page.waitForTimeout(500);
                const submitSelectors = ['button:has-text("Enviar pedido")', 'button:has-text("Send request")', 'button:has-text("Submit")', 'button:has-text("Join")'];
                for (const sel of submitSelectors) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 1000 }).catch(() => false) && !await btn.isDisabled().catch(() => false)) {
                        await btn.click();
                        break;
                    }
                }
            } catch { /* ignore */ }
        }

        return { submitted: false, error: `r/${subreddit}: private community (join request sent)` };
    }

    // ======== SELECIONAR ABA DE IMAGEM ========
    console.log('📷 Selecionando aba de imagem...');
    // Reddit 2026 UI uses role="tab" buttons with text labels
    const imageTabTexts = ['Imagens e vídeo', 'Images & Video', 'Images', 'Imagens', 'Image & Video'];
    let imageTabClicked = false;
    for (const tabText of imageTabTexts) {
        try {
            const tab = page.locator(`button[role="tab"]`).filter({ hasText: tabText }).first();
            if (await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
                await tab.click();
                console.log(`  ✅ Image tab: "${tabText}"`);
                imageTabClicked = true;
                await page.waitForTimeout(3000);
                break;
            }
        } catch { continue; }
    }
    if (!imageTabClicked) {
        // Fallback: try clicking by URL parameter
        const currentUrl = page.url();
        if (!currentUrl.includes('type=IMAGE')) {
            await page.goto(`https://www.reddit.com/r/${subreddit}/submit?type=IMAGE`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            console.log('  ✅ Image tab via URL parameter');
        }
    }

    // ======== UPLOAD IMAGEM — via filechooser event (Shadow DOM safe) ========
    console.log('📤 Uploading imagem...');
    let uploadConfirmed = false;

    // Approach 1: Use Playwright's filechooser event — works across Shadow DOMs
    try {
        // Find the upload button to click (outside or piercing shadow DOM)
        const uploadBtnSelectors = [
            '#device-upload-button',
            'button:has-text("Carregar ficheiros")',
            'button:has-text("Upload files")',
            'button:has-text("Carregar")',
            'button:has-text("Upload")',
        ];

        let uploadBtn = null;
        for (const sel of uploadBtnSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    uploadBtn = btn;
                    console.log(`  ✅ Upload button found: ${sel}`);
                    break;
                }
            } catch { continue; }
        }

        if (!uploadBtn) {
            // Fallback: click on the drop zone area text
            const dropZoneTexts = ['Arrasta e solta', 'Drag and drop', 'carrega multimédia', 'upload media'];
            for (const text of dropZoneTexts) {
                try {
                    const area = page.getByText(text, { exact: false }).first();
                    if (await area.isVisible({ timeout: 1500 }).catch(() => false)) {
                        uploadBtn = area;
                        console.log(`  ✅ Drop zone found: "${text}"`);
                        break;
                    }
                } catch { continue; }
            }
        }

        if (uploadBtn) {
            // Listen for filechooser BEFORE clicking
            const [fileChooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 10000 }),
                uploadBtn.click(),
            ]);
            await fileChooser.setFiles(tempImagePath);
            console.log('  ✅ Upload via filechooser event');
        } else {
            // Fallback: try setInputFiles directly (Playwright pierces some shadow DOMs)
            console.log('  ⚠️ Upload button not found, trying direct input...');
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(tempImagePath, { timeout: 10000 });
            console.log('  ✅ Upload via direct setInputFiles');
        }
    } catch (e) {
        console.log('  ⚠️ Primary upload failed, trying force approach...');
        // Fallback 2: Inject input and set files via evaluate
        try {
            await page.evaluate(() => {
                document.querySelectorAll('input[type="file"]').forEach(input => {
                    const el = input as HTMLInputElement;
                    el.style.display = 'block';
                    el.style.opacity = '1';
                    el.style.position = 'fixed';
                    el.style.top = '0';
                    el.style.left = '0';
                    el.style.zIndex = '99999';
                    el.style.width = '200px';
                    el.style.height = '50px';
                });
                // Also check shadow roots
                function walkShadows(root: any): void {
                    root.querySelectorAll('*').forEach((el: any) => {
                        if (el.shadowRoot) {
                            el.shadowRoot.querySelectorAll('input[type="file"]').forEach((input: any) => {
                                input.style.display = 'block';
                                input.style.opacity = '1';
                                input.style.position = 'fixed';
                                input.style.top = '60px';
                                input.style.left = '0';
                                input.style.zIndex = '99999';
                            });
                            walkShadows(el.shadowRoot);
                        }
                    });
                }
                walkShadows(document);
            });
            await page.waitForTimeout(500);
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(tempImagePath, { timeout: 10000 });
            console.log('  ✅ Upload via forced visibility');
        } catch (e2) {
            console.log('  ❌ All upload methods failed:', e2 instanceof Error ? e2.message.substring(0, 80) : '');
        }
    }

    // Aguardar preview — até 45 segundos
    console.log('  ⏳ Aguardando preview da imagem...');
    const uploadPreviewSelectors = [
        'img[src*="preview.redd.it"]',
        'img[src*="i.redd.it"]',
        'img[src*="redditmedia"]',
        'faceplate-img',
        'button[aria-label*="Remove"]',
        'button[aria-label*="Remover"]',
        'button[aria-label*="Eliminar"]',
    ];

    for (let attempt = 0; attempt < 45; attempt++) {
        for (const sel of uploadPreviewSelectors) {
            try {
                if (await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log(`  ✅ Upload confirmado via: ${sel}`);
                    uploadConfirmed = true;
                    break;
                }
            } catch { continue; }
        }
        if (uploadConfirmed) break;
        await page.waitForTimeout(1000);
        if (attempt % 5 === 4) console.log(`  ⏳ Aguardando upload... (${attempt + 1}s)`);
    }

    if (!uploadConfirmed) {
        console.log('  ⚠️ Preview não detectado — continuando mesmo assim');
    }

    // ======== PREENCHER TÍTULO ========
    console.log('📝 Preenchendo título...');
    const titleSelectors = [
        '#innerTextArea',  // Reddit 2026 Shadow DOM title (inside faceplate-textarea-input)
        'textarea[slot="title"]', 'textarea[name="title"]',
        'textarea[placeholder*="Título"]', 'textarea[placeholder*="Title"]',
        'textarea[placeholder*="título"]',
        'input[placeholder*="Title"]', 'input[placeholder*="Título"]',
    ];
    let titleFilled = false;
    for (const sel of titleSelectors) {
        try {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
                await input.click();
                await input.fill(title);
                // Dispatch events for React/Web Components to pick up the value
                await page.evaluate((s) => {
                    function walkAndFind(root: any): HTMLElement | null {
                        var el = root.querySelector(s) as HTMLElement | null;
                        if (el) return el;
                        for (var _i = 0, _a = Array.from(root.querySelectorAll('*')) as any[]; _i < _a.length; _i++) {
                            if (_a[_i].shadowRoot) {
                                var found: HTMLElement | null = walkAndFind(_a[_i].shadowRoot);
                                if (found) return found;
                            }
                        }
                        return null;
                    }
                    var el = walkAndFind(document);
                    if (el) {
                        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
                    }
                }, sel);
                titleFilled = true;
                console.log(`  ✅ Título via: ${sel}`);
                break;
            }
        } catch { continue; }
    }
    if (!titleFilled) {
        // Fallback: type via keyboard after focusing
        console.log('  ⚠️ Seletores de título falharam, usando keyboard...');
        await page.keyboard.press('Tab');
        await page.keyboard.type(title, { delay: 30 });
    }
    await page.waitForTimeout(800);

    // ======== NSFW + FLAIR — via unified "Adicionar tags" modal (Reddit 2026) ========
    // In the new Reddit UI, NSFW toggle AND flair are BOTH inside the same tags modal
    console.log('🏷️ Abrindo modal de tags (NSFW + Flair)...');

    async function tryOpenTagsModal(): Promise<boolean> {
        const tagsButtonSelectors = [
            '#reddit-post-flair-button',
            'button:has-text("Adicionar tags")',
            'button:has-text("Add tags")',
            'button:has-text("Adicionar flair")',
            'button:has-text("Add flair")',
        ];

        for (const sel of tagsButtonSelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await btn.click();
                    console.log(`  🏷️ Tags modal aberto via: ${sel}`);
                    await page.waitForTimeout(1500);
                    return true;
                }
            } catch { continue; }
        }
        console.log('  ℹ️ Sem botão de tags — não obrigatório');
        return false;
    }

    async function tryHandleTagsModal(): Promise<boolean> {
        const modalOpened = await tryOpenTagsModal();
        if (!modalOpened) {
            // Try standalone NSFW button as fallback (some subs may have it outside modal)
            if (isNsfw) {
                const nsfwSelectors = [
                    'button:has-text("NSFW")',
                    'faceplate-switch[input-name="nsfw"]',
                    'button[aria-label*="NSFW"]',
                ];
                for (const sel of nsfwSelectors) {
                    try {
                        const btn = page.locator(sel).first();
                        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                            await btn.click();
                            console.log(`  ✅ NSFW standalone: ${sel}`);
                            break;
                        }
                    } catch { continue; }
                }
            }
            return false;
        }

        // === Inside the tags modal now ===

        // 1. Toggle NSFW if needed
        if (isNsfw) {
            console.log('  🔞 Procurando toggle NSFW no modal...');
            try {
                // The NSFW switch is a faceplate-switch-input with label "Conteúdo adulto (18+)" or similar
                const nsfwToggled = await page.evaluate((): string => {
                    function walkShadows(root: any): any[] {
                        var results: any[] = [];
                        root.querySelectorAll('*').forEach(function (el: any) {
                            if (el.tagName.toLowerCase().includes('switch') ||
                                el.getAttribute('input-name') === 'nsfw' ||
                                el.getAttribute('role') === 'switch') {
                                results.push(el);
                            }
                            if (el.shadowRoot) {
                                results.push.apply(results, walkShadows(el.shadowRoot));
                            }
                        });
                        return results;
                    }

                    var switches = walkShadows(document);
                    for (var _i = 0; _i < switches.length; _i++) {
                        var sw = switches[_i];
                        var parentText = ((sw.closest('label') || sw.parentElement) || {}).textContent || '';
                        parentText = parentText.toLowerCase();
                        if (parentText.includes('nsfw') || parentText.includes('adulto') || parentText.includes('18+') || parentText.includes('adult')) {
                            sw.click();
                            return `switch:${parentText.substring(0, 40)}`;
                        }
                    }

                    var inputs = document.querySelectorAll('input[type="checkbox"], input[name*="nsfw"]');
                    for (var _j = 0; _j < inputs.length; _j++) {
                        var label = ((inputs[_j] as any).closest('label') || {} as any).textContent || '';
                        if (label.toLowerCase().includes('nsfw') || label.toLowerCase().includes('adulto') || label.toLowerCase().includes('18+')) {
                            (inputs[_j] as any).click();
                            return 'checkbox:' + label.substring(0, 40);
                        }
                    }

                    return 'not-found';
                });

                if (nsfwToggled !== 'not-found') {
                    console.log(`  ✅ NSFW toggled: ${nsfwToggled}`);
                } else {
                    // Try Playwright locator as fallback
                    const nsfwLabels = ['Conteúdo adulto', 'Adult content', 'NSFW', '18+'];
                    for (const label of nsfwLabels) {
                        try {
                            const toggle = page.getByText(label, { exact: false }).first();
                            if (await toggle.isVisible({ timeout: 500 }).catch(() => false)) {
                                await toggle.click();
                                console.log(`  ✅ NSFW via text: "${label}"`);
                                break;
                            }
                        } catch { continue; }
                    }
                }
            } catch (e) {
                console.log('  ⚠️ NSFW toggle error:', e instanceof Error ? e.message.substring(0, 60) : '');
            }
            await page.waitForTimeout(500);
        }

        // 2. Select flair if available
        console.log('  🏷️ Verificando opções de flair no modal...');
        const flairOptions = await page.evaluate((): string[] => {
            const options: string[] = [];
            function walkShadows(root: any): void {
                root.querySelectorAll('input[type="radio"]').forEach(function (radio: any) {
                    var label = radio.closest('label') || root.querySelector('label[for="' + radio.id + '"]');
                    var text = ((label ? label.textContent : '') || radio.value || '').trim();
                    if (text && !options.includes(text)) options.push(text);
                });
                root.querySelectorAll('[role="radio"], [role="option"]').forEach(function (el: any) {
                    var text = (el.textContent || '').trim();
                    if (text && !options.includes(text)) options.push(text);
                });
                root.querySelectorAll('*').forEach(function (el: any) {
                    if (el.shadowRoot) walkShadows(el.shadowRoot);
                });
            };
            walkShadows(document);
            return options.filter(o =>
                !['Adicionar', 'Add', 'Apply', 'Cancelar', 'Cancel', 'Done'].includes(o) &&
                !o.toLowerCase().includes('adulto') && !o.toLowerCase().includes('nsfw') &&
                !o.toLowerCase().includes('spoiler') && o.length < 100
            );
        });

        if (flairOptions.length > 0) {
            console.log(`  📋 Flair options: ${flairOptions.join(', ')}`);

            // Choose best flair
            const preferredTexts = [
                'sem flair', 'no flair', 'none', 'nenhum', 'nenhuma',
                'general', 'oc', 'original content', 'image', 'photo',
            ];
            let chosen = flairOptions[0];
            for (const preferred of preferredTexts) {
                const match = flairOptions.find(o => o.toLowerCase().includes(preferred));
                if (match) { chosen = match; break; }
            }

            console.log(`  🏷️ Escolhendo flair: "${chosen}"`);

            // Click the chosen flair option
            const clicked = await page.evaluate((targetText: string) => {
                function walkAndClick(root: any): string | null {
                    var radios = Array.from(root.querySelectorAll('input[type="radio"]')) as any[];
                    for (var i = 0; i < radios.length; i++) {
                        var radio = radios[i];
                        var label = radio.closest('label') || root.querySelector('label[for="' + radio.id + '"]');
                        var text = ((label ? label.textContent : '') || radio.value || '').trim();
                        if (text === targetText) { radio.click(); return 'radio:' + text; }
                    }
                    var els = Array.from(root.querySelectorAll('[role="radio"], [role="option"], li, label')) as any[];
                    for (var j = 0; j < els.length; j++) {
                        var text2 = (els[j].textContent || '').trim();
                        if (text2 === targetText) { els[j].click(); return 'role:' + text2; }
                    }
                    var allEls = Array.from(root.querySelectorAll('*')) as any[];
                    for (var k = 0; k < allEls.length; k++) {
                        if (allEls[k].shadowRoot) {
                            var result: string | null = walkAndClick(allEls[k].shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }
                return walkAndClick(document);
            }, chosen);

            if (clicked) {
                console.log(`  ✅ Flair selecionado: ${clicked}`);
            } else {
                console.log('  ⚠️ Não conseguiu selecionar flair via DOM');
            }
            await page.waitForTimeout(500);
        } else {
            console.log('  ℹ️ Sem opções de flair neste sub');
        }

        // 3. Click Apply/Adicionar button to confirm and close modal
        console.log('  ✅ Confirmando modal...');
        const applySelectors = [
            '#post-flair-modal-apply-button',
            'button:has-text("Adicionar")',
            'button:has-text("Apply")',
            'button:has-text("Add")',
            'button:has-text("Done")',
            'button:has-text("Save")',
        ];

        let modalConfirmed = false;
        for (const sel of applySelectors) {
            try {
                const btn = page.locator(sel).first();
                if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    if (!await btn.isDisabled().catch(() => false)) {
                        await btn.click();
                        console.log(`  ✅ Modal confirmado via: ${sel}`);
                        modalConfirmed = true;
                        break;
                    }
                }
            } catch { continue; }
        }

        if (!modalConfirmed) {
            // Fallback: try DOM-based click on apply/add button
            const confirmed = await page.evaluate((): string | null => {
                const confirmTexts = ['Adicionar', 'Add', 'Apply', 'Done', 'OK'];
                function walkShadows(root: any): string | null {
                    var buttons = Array.from(root.querySelectorAll('button')) as any[];
                    for (var i = 0; i < buttons.length; i++) {
                        var text = (buttons[i].textContent || '').trim();
                        for (var j = 0; j < confirmTexts.length; j++) {
                            if (text === confirmTexts[j] || (text.includes(confirmTexts[j]) && text.toLowerCase().indexOf('flair') === -1 && text.toLowerCase().indexOf('tags') === -1)) {
                                buttons[i].click();
                                return text;
                            }
                        }
                    }
                    var allEls = Array.from(root.querySelectorAll('*')) as any[];
                    for (var k = 0; k < allEls.length; k++) {
                        if (allEls[k].shadowRoot) {
                            var result = walkShadows(allEls[k].shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                };
                return walkShadows(document);
            });

            if (confirmed) {
                console.log(`  ✅ Modal confirmado via DOM: "${confirmed}"`);
                modalConfirmed = true;
            } else {
                console.log('  ⚠️ Fechando modal via Escape');
                await page.keyboard.press('Escape').catch(() => { });
            }
        }

        await page.waitForTimeout(800);
        return true;
    }

    await tryHandleTagsModal();

    // Verificar imagem ainda presente após flair
    console.log('🔍 Verificando imagem após flair...');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);

    const imageStillUploaded = await page.evaluate(() =>
        !!document.querySelector('img[src*="redditmedia"], img[src*="reddit"], img[src*="preview"], button[aria-label*="Remove"], button[aria-label*="Remover"]')
    );

    if (!imageStillUploaded) {
        console.log('  ⚠️ Imagem perdida após flair! Re-fazendo upload...');
        try {
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(tempImagePath);
            await page.waitForTimeout(10000);
        } catch (e) {
            console.log('  ❌ Re-upload falhou');
        }
    } else {
        console.log('  ✅ Imagem ainda presente');
    }

    // ======== SUBMIT ========
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    // Disparar validação do React (com composed: true para atravessar Shadow DOM)
    await page.evaluate(() => {
        function dispatchEvents(root: any): void {
            root.querySelectorAll('textarea, input').forEach((el: any) => {
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
            });
            root.querySelectorAll('*').forEach((el: any) => {
                if (el.shadowRoot) dispatchEvents(el.shadowRoot);
            });
        }
        dispatchEvents(document);
    });
    await page.waitForTimeout(500);

    console.log('🚀 Submetendo post...');
    let submitted = false;

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
            if (!await btn.isVisible({ timeout: 2000 }).catch(() => false)) continue;

            // Aguarda até 20s pelo botão habilitar
            for (let i = 0; i < 20; i++) {
                if (!await btn.isDisabled().catch(() => true)) break;

                if (i === 8) {
                    // Submit ainda desabilitado — tentar tags modal de novo
                    console.log('  🏷️ Submit desabilitado — tentando tags modal de novo...');
                    await tryHandleTagsModal();
                    await page.waitForTimeout(1000);
                }

                if (i % 5 === 0 && i > 0) {
                    await page.evaluate(() => {
                        function dispatchInShadows(root: any): void {
                            root.querySelectorAll('textarea, input').forEach((el: any) => {
                                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                                el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
                            });
                            root.querySelectorAll('*').forEach((el: any) => {
                                if (el.shadowRoot) dispatchInShadows(el.shadowRoot);
                            });
                        }
                        dispatchInShadows(document);
                        document.body.click();
                    });
                }
                await page.waitForTimeout(1000);
            }

            if (!await btn.isDisabled().catch(() => false)) {
                await btn.click({ timeout: 10000 });
                submitted = true;
                console.log(`  ✅ Submit via: ${sel}`);
                break;
            } else {
                console.log(`  ⚠️ Botão ainda desabilitado após 30s`);
            }
        } catch (e) {
            console.log(`  ⚠️ ${sel}:`, e instanceof Error ? e.message.substring(0, 80) : '');
        }
    }

    // Force-click como último recurso
    if (!submitted) {
        console.log('  🔧 Force-enabling submit button...');
        const forceResult = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const submit = buttons.find(b => {
                const text = (b.textContent?.trim() || '').toLowerCase();
                return (text === 'post' || text === 'publicar' || text === 'submit') && b.type === 'submit';
            });
            if (submit) {
                submit.disabled = false;
                submit.removeAttribute('disabled');
                submit.removeAttribute('aria-disabled');
                submit.click();
                return 'force-clicked';
            }
            const composers = document.querySelectorAll('shreddit-composer');
            for (const comp of Array.from(composers)) {
                const shadow = (comp as HTMLElement).shadowRoot;
                if (shadow) {
                    const shadowBtn = shadow.querySelector('button[type="submit"]') as HTMLButtonElement | null;
                    if (shadowBtn) { shadowBtn.disabled = false; shadowBtn.removeAttribute('disabled'); shadowBtn.click(); return 'shadow-force-clicked'; }
                }
            }
            return 'not-found';
        });
        console.log(`  🔧 Force result: ${forceResult}`);
        if (forceResult.includes('clicked')) submitted = true;
    }

    // ======== HANDLE NSFW MODAL PÓS-SUBMIT ========
    await page.waitForTimeout(2000);
    console.log('  🔍 Verificando modal NSFW/confirmação...');

    const nsfwConfirmSelectors = [
        'dialog button:has-text("Yes")', 'dialog button:has-text("Continue")',
        'dialog button:has-text("Confirm")', 'dialog button:has-text("Post")',
        'dialog button:has-text("Sim")', 'dialog button:has-text("Continuar")',
        '[role="dialog"] button:has-text("Yes")', '[role="dialog"] button:has-text("Continue")',
        '[role="dialog"] button:has-text("Post")', '[role="alertdialog"] button:has-text("Confirm")',
    ];

    for (const sel of nsfwConfirmSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await btn.click();
                console.log(`  ✅ Modal NSFW confirmado: ${sel}`);
                await page.waitForTimeout(2000);
                break;
            }
        } catch { continue; }
    }

    // JS fallback para modais em shadow DOM
    try {
        const modalResult = await page.evaluate(() => {
            const dialogs = document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]');
            for (const dialog of Array.from(dialogs)) {
                if (!(dialog as HTMLElement).offsetParent && !(dialog as HTMLDialogElement).open) continue;
                for (const btn of Array.from(dialog.querySelectorAll('button'))) {
                    const text = btn.textContent?.trim().toLowerCase() || '';
                    if (['yes', 'continue', 'confirm', 'post', 'sim', 'continuar', 'ok'].includes(text)) {
                        (btn as HTMLButtonElement).click();
                        return `confirmed: ${text}`;
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

    // ======== AGUARDAR REDIRECT ========
    await page.waitForTimeout(2000);
    let postUrl = page.url();

    if (postUrl.includes('/submit')) {
        console.log('  ⏳ Aguardando redirect...');
        try {
            await page.waitForURL((url) => !url.toString().includes('/submit'), { timeout: 30000 });
            postUrl = page.url();
            console.log(`  ✅ Redirect: ${postUrl}`);
        } catch {
            const afterPath = path.join(COOKIES_DIR, `debug_after_submit_${Date.now()}.png`);
            await page.screenshot({ path: afterPath });
            console.log(`  ⚠️ Sem redirect após 30s. Screenshot: ${afterPath}`);
            postUrl = page.url();
        }
    }

    const postSuccess = postUrl.includes('/comments/') || (postUrl.includes('/r/') && !postUrl.includes('/submit'));
    if (postSuccess) return { submitted: true, url: postUrl };

    return { submitted: false, error: 'new_reddit_failed' };
}

// =============================================
// Old Reddit Fallback
// =============================================

async function tryOldRedditSubmit(
    page: Page,
    subreddit: string,
    title: string,
    tempImagePath: string,
    isNsfw: boolean
): Promise<{ submitted: boolean; url?: string; errorMsg?: string }> {
    try {
        await page.goto(`https://old.reddit.com/r/${subreddit}/submit`, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(randomDelay(3000, 5000));

        const loggedIn = await page.locator('.user a').isVisible({ timeout: 3000 }).catch(() => false);
        if (!loggedIn) return { submitted: false, errorMsg: 'Not logged in on old.reddit.com' };

        const linkTab = page.locator('a[href*="submit"], .submit-link, ul.tabmenu li a').filter({ hasText: /image|link|imagem/i }).first();
        if (await linkTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await linkTab.click();
            await page.waitForTimeout(1000);
        }

        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
            await fileInput.setInputFiles(tempImagePath);
            console.log('  ✅ File uploaded on old Reddit');
            await page.waitForTimeout(5000);
        } else {
            return { submitted: false, errorMsg: 'Old Reddit does not support direct file upload' };
        }

        const titleInput = page.locator('[name="title"], #title-field textarea, textarea[name="title"]').first();
        if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
            await titleInput.fill(title);
        }

        if (isNsfw) {
            const nsfwCheckbox = page.locator('input[name="over_18"], input#over18').first();
            if (await nsfwCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) await nsfwCheckbox.check();
        }

        const submitBtn = page.locator('button[type="submit"]:has-text("submit"), #submit_btn').first();
        if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await submitBtn.click();
        } else {
            await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(3000);

        let postUrl = page.url();
        if (postUrl.includes('/submit')) {
            try {
                await page.waitForURL((url) => !url.toString().includes('/submit'), { timeout: 30000 });
                postUrl = page.url();
            } catch {
                return { submitted: false, errorMsg: 'Old Reddit submit did not redirect' };
            }
        }

        const success = postUrl.includes('/comments/') || (postUrl.includes('/r/') && !postUrl.includes('/submit'));
        if (success) return { submitted: true, url: postUrl };
        return { submitted: false, errorMsg: `Old Reddit ended at: ${postUrl}` };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { submitted: false, errorMsg: errMsg };
    }
}

// =============================================
// Reddit Discovery
// =============================================

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
                .map(el => el.textContent?.trim() || '').filter(t => t.length > 0);
            const subscribersEl = document.querySelector('[id*="subscribers"], [data-testid="members-count"]');
            return {
                rules,
                subscribers: subscribersEl?.textContent || 'unknown',
                nsfw: document.body.textContent?.toLowerCase().includes('nsfw') || false,
            };
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

export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

function randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
