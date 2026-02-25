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

async function getModelContext(modelId: string): Promise<BrowserContext> {
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
                await page.waitForTimeout(1500);
                break;
            }
        } catch { continue; }
    }

    // ======== CORREÇÃO 1: UPLOAD — clicar no ícone primeiro, depois setInputFiles ========
    // A screenshot mostra que a área de upload fica vazia porque o input[type="file"]
    // só aceita arquivos depois que o dropzone é ativado com um clique.
    console.log('📤 Uploading imagem...');
    let uploadConfirmed = false;

    // Passo 1: clicar no ícone/botão de upload para ativar o input
    const uploadTriggerSelectors = [
        // Ícone de upload (seta para cima) visível na screenshot
        'button[aria-label*="upload" i]',
        'button[aria-label*="Upload" i]',
        '[data-testid="image-upload-button"]',
        'shreddit-gallery-input button',
        // Qualquer elemento clicável dentro da área de drop
        'div[class*="upload"] button',
        'div[class*="dropzone"] button',
        // O ícone SVG de upload que aparece na screenshot
        'svg[icon-name="upload-outline"]',
        'faceplate-icon[icon-name="upload-outline"]',
    ];

    for (const sel of uploadTriggerSelectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                await el.click();
                console.log(`  ✅ Clicou no trigger de upload: ${sel}`);
                await page.waitForTimeout(500);
                break;
            }
        } catch { continue; }
    }

    // Passo 2: setInputFiles no input[type="file"]
    try {
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tempImagePath, { timeout: 10000 });
        console.log('  ✅ setInputFiles executado');
    } catch (e) {
        console.log('  ⚠️ setInputFiles direto falhou, tentando forçar visibilidade...');
        // Forçar visibilidade do input e tentar novamente
        try {
            await page.evaluate(() => {
                const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
                if (input) {
                    input.style.display = 'block';
                    input.style.opacity = '1';
                    input.style.position = 'fixed';
                    input.style.top = '0';
                    input.style.left = '0';
                    input.style.zIndex = '9999';
                }
            });
            const fileInput = page.locator('input[type="file"]').first();
            await fileInput.setInputFiles(tempImagePath, { timeout: 10000 });
            console.log('  ✅ setInputFiles após forçar visibilidade');
        } catch (e2) {
            console.log('  ❌ Upload falhou:', e2 instanceof Error ? e2.message.substring(0, 80) : '');
        }
    }

    // Aguardar preview — até 45 segundos
    console.log('  ⏳ Aguardando preview da imagem...');
    const uploadPreviewSelectors = [
        'shreddit-composer img[src*="preview.redd.it"]',
        'shreddit-composer img[src*="i.redd.it"]',
        'shreddit-composer img[src*="redditmedia"]',
        'shreddit-composer faceplate-img',
        'div[data-testid="image-preview"] img',
        'shreddit-gallery-carousel img',
        'button[aria-label*="Remove"]',
        'button[aria-label*="Remover"]',
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
        const dbgPath = path.join(COOKIES_DIR, `debug_upload_${Date.now()}.png`);
        await page.screenshot({ path: dbgPath, fullPage: true });
        console.log(`  ⚠️ Preview não detectado. Screenshot: ${dbgPath}`);
    }

    // ======== PREENCHER TÍTULO ========
    console.log('📝 Preenchendo título...');
    const titleSelectors = [
        'textarea[slot="title"]', 'textarea[name="title"]',
        'textarea[placeholder*="Title"]', 'textarea[placeholder*="Título"]',
        'input[placeholder*="Title"]', '[data-test-id="post-title"] textarea',
    ];
    let titleFilled = false;
    for (const sel of titleSelectors) {
        try {
            const input = page.locator(sel).first();
            if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
                await input.click();
                await input.fill(title);
                await page.evaluate((s) => {
                    const el = document.querySelector(s) as HTMLElement | null;
                    if (el) {
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }, sel);
                titleFilled = true;
                console.log(`  ✅ Título via: ${sel}`);
                break;
            }
        } catch { continue; }
    }
    if (!titleFilled) {
        await page.keyboard.press('Tab');
        await page.keyboard.type(title, { delay: 30 });
    }
    await page.waitForTimeout(800);

    // ======== NSFW ========
    if (isNsfw) {
        console.log('🔞 Marcando NSFW...');
        const nsfwSelectors = [
            'button:has-text("NSFW")',
            'faceplate-switch[input-name="nsfw"]',
            'button[aria-label*="NSFW"]',
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
        await page.waitForTimeout(500);
    }

    // ======== CORREÇÕES 2 + 3: FLAIR COM CONFIRMAÇÃO DENTRO DO MODAL ========
    console.log('🏷️ Verificando flair...');

    async function trySelectFlairWithVision(): Promise<boolean> {
        // Passo 1: verificar se há flair picker
        const result = await askClaudeWhatToClick(
            page,
            'I am on a Reddit post submission page. Is there a flair picker or "Add flair" / "Adicionar flair" button visible? If yes, tell me the exact text to click to open it. If flair is already selected or not required, say action "none".'
        );

        if (result.action === 'none') {
            console.log('  ℹ️ Flair não necessário');
            return false;
        }
        if (!result.target) return false;

        console.log(`  🏷️ Abrindo flair picker: "${result.target}"`);

        // Abrir o picker
        let opened = false;
        try {
            await page.getByText(result.target, { exact: false }).first().click({ timeout: 3000 });
            opened = true;
        } catch { }
        if (!opened) {
            try {
                await page.click(`text="${result.target}"`, { timeout: 3000, force: true });
                opened = true;
            } catch { }
        }
        if (!opened) {
            opened = await page.evaluate((t: string) => {
                for (const el of document.querySelectorAll('button, div, span, a, [role="button"]')) {
                    if ((el.textContent || '').trim().toLowerCase().includes(t.toLowerCase()) && (el as HTMLElement).offsetHeight > 0) {
                        (el as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            }, result.target);
        }

        if (!opened) {
            console.log('  ⚠️ Não conseguiu abrir flair picker');
            return false;
        }

        await page.waitForTimeout(1500);

        // Passo 2: Claude escolhe a opção
        const optionResult = await askClaudeWhatToClick(
            page,
            'I opened a flair picker on Reddit. I can see flair options as radio buttons or a list. Pick the SAFEST and most GENERIC flair (e.g. "Sem flair", "No Flair", "General", "OC", "Image"). IMPORTANT: Do NOT select "Adicionar", "Add", "Apply", "Cancelar" or "Cancel" — those are action buttons, not flair options. Tell me the EXACT visible text of the FLAIR OPTION to select (the radio button label). List ALL flair options in allOptions.'
        );

        if (optionResult.action === 'none' || !optionResult.target) {
            console.log('  ⚠️ Claude não encontrou opções');
            await page.keyboard.press('Escape').catch(() => { });
            return false;
        }

        console.log(`  🏷️ Selecionando: "${optionResult.target}"`);
        if (optionResult.allOptions?.length) console.log(`  📋 Opções: ${optionResult.allOptions.join(', ')}`);

        const targetText = optionResult.target;
        let picked = false;

        if (!picked) { try { await page.click(`text="${targetText}"`, { timeout: 3000, force: true }); picked = true; } catch { } }
        if (!picked) { try { await page.getByText(targetText, { exact: false }).first().click({ force: true, timeout: 3000 }); picked = true; } catch { } }
        if (!picked) { try { await page.getByRole('option', { name: targetText }).first().click({ force: true, timeout: 2000 }); picked = true; } catch { try { await page.getByRole('radio', { name: targetText }).first().click({ force: true, timeout: 2000 }); picked = true; } catch { } } }
        if (!picked) {
            picked = await page.evaluate((text: string) => {
                function searchShadowDOM(root: Document | ShadowRoot | Element): boolean {
                    for (const el of root.querySelectorAll('li, label, span, div, button, [role="option"], [role="radio"]')) {
                        const t = (el.textContent || '').trim();
                        if (t === text || (t.includes(text) && t.length < text.length + 20)) { (el as HTMLElement).click(); return true; }
                    }
                    for (const el of root.querySelectorAll('*')) {
                        if ((el as HTMLElement).shadowRoot && searchShadowDOM((el as HTMLElement).shadowRoot!)) return true;
                    }
                    return false;
                }
                return searchShadowDOM(document);
            }, targetText);
        }

        if (!picked) {
            console.log('  ⚠️ Não conseguiu clicar na opção');
            await page.keyboard.press('Escape').catch(() => { });
            return false;
        }

        await page.waitForTimeout(1000);

        // ======== CORREÇÃO CRÍTICA: CONFIRMAR DENTRO DO MODAL ========
        // NÃO usar Escape ou click fora — isso cancela a seleção no Reddit.
        // Pedir ao Claude para encontrar o botão de confirmação DENTRO do modal.
        console.log('  💾 Confirmando flair dentro do modal...');

        const confirmResult = await askClaudeWhatToClick(
            page,
            `I just selected a flair radio button in a Reddit flair modal. I need to SAVE/CONFIRM this selection now.
Look for the BLUE confirmation button inside the modal — in Portuguese Reddit it's called "Adicionar", in English it may be "Apply", "Add", "Save flairs", or "Done".
This button is usually blue/filled and at the bottom-right of the modal.
Do NOT suggest "Cancelar" or "Cancel". Do NOT suggest clicking outside the modal.
If the modal already closed automatically, say action "none".`
        );

        let confirmed = false;

        if (confirmResult.action === 'none') {
            console.log('  ✅ Modal fechou automaticamente — flair salvo');
            confirmed = true;
        } else if (confirmResult.target) {
            console.log(`  💾 Clicando botão de confirmação: "${confirmResult.target}"`);

            // Tentar clicar DENTRO de containers de modal — nunca fora
            const modalContainers = [
                'dialog', '[role="dialog"]', 'shreddit-post-flair-picker',
                'flair-selector', '[class*="modal"]', 'shreddit-async-loader',
            ];

            for (const modalSel of modalContainers) {
                try {
                    const modal = page.locator(modalSel).first();
                    if (!await modal.isVisible({ timeout: 500 }).catch(() => false)) continue;
                    const btnInModal = modal.getByText(confirmResult.target, { exact: false }).first();
                    if (await btnInModal.isVisible({ timeout: 1000 }).catch(() => false)) {
                        await btnInModal.click({ force: true });
                        confirmed = true;
                        console.log(`  ✅ Confirmado dentro do modal`);
                        break;
                    }
                } catch { continue; }
            }

            if (!confirmed) {
                try {
                    const btn = page.getByRole('button', { name: new RegExp(confirmResult.target, 'i') }).first();
                    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                        await btn.click({ force: true });
                        confirmed = true;
                    }
                } catch { }
            }
        }

        // Fallback: selectors conhecidos de confirmação
        // IMPORTANTE: "Adicionar" é o botão azul de confirmação no Reddit em PT
        // (não confundir com "Adicionar flair" que ABRE o picker)
        if (!confirmed) {
            const applySelectors = [
                // Reddit PT — botão azul de confirmar no modal de flair
                '[role="dialog"] button:has-text("Adicionar"):not(:has-text("flair")):not(:has-text("tags"))',
                'dialog button:has-text("Adicionar"):not(:has-text("flair")):not(:has-text("tags"))',
                // Reddit EN
                '[role="dialog"] button:has-text("Apply")',
                '[role="dialog"] button:has-text("Save flairs")',
                '[role="dialog"] button:has-text("Done")',
                '[role="dialog"] button:has-text("Add")',
                // Shreddit components
                'shreddit-post-flair-picker button[type="submit"]',
                'flair-selector button[type="submit"]',
                'dialog button[type="submit"]',
            ];
            for (const sel of applySelectors) {
                try {
                    const btn = page.locator(sel).first();
                    if (!await btn.isVisible({ timeout: 1000 }).catch(() => false)) continue;
                    const btnText = await btn.textContent().catch(() => '');
                    // Ignorar botões que ABREM o picker (contêm "flair" ou "tags" no texto)
                    const txt = btnText?.toLowerCase() || '';
                    if (txt.includes('flair') || txt.includes('tags') || txt.includes('adicionar flair') || txt.includes('adicionar tags')) continue;
                    await btn.click({ force: true });
                    confirmed = true;
                    console.log(`  ✅ Confirmado via: "${btnText?.trim()}"`);
                    await page.waitForTimeout(500);
                    break;
                } catch { continue; }
            }
        }

        // Escape apenas como último recurso absoluto
        if (!confirmed) {
            console.log('  ⚠️ Usando Escape como último recurso');
            await page.keyboard.press('Escape').catch(() => { });
            await page.waitForTimeout(500);
        }

        await page.waitForTimeout(1000);

        const flairConfirmed = await page.evaluate((text) =>
            document.body.innerHTML.toLowerCase().includes(text.toLowerCase()), targetText
        );
        console.log(`  ${flairConfirmed ? '✅' : '⚠️'} Flair "${targetText}" ${flairConfirmed ? 'confirmado no formulário' : 'pode não ter sido salvo'}`);

        return true;
    }

    await trySelectFlairWithVision();
    await page.waitForTimeout(500);

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

    const debugPath = path.join(COOKIES_DIR, `debug_submit_${Date.now()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`📸 Debug: ${debugPath}`);

    // Disparar validação do React
    await page.evaluate(() => {
        document.querySelectorAll('textarea, input').forEach(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });
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

            // Aguarda até 30s pelo botão habilitar
            for (let i = 0; i < 30; i++) {
                if (!await btn.isDisabled().catch(() => true)) break;

                if (i === 10) {
                    console.log('  🏷️ Submit desabilitado — tentando flair de novo...');
                    await trySelectFlairWithVision();
                    await page.waitForTimeout(1000);
                }

                if (i % 5 === 0 && i > 0) {
                    await page.evaluate(() => {
                        document.querySelectorAll('textarea, input').forEach(el => {
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        });
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
