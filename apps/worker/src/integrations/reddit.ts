import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { getSupabaseAdmin } from '@velvetscale/db';
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
    password: string
): Promise<{ success: boolean; error?: string }> {
    let context: BrowserContext | null = null;

    try {
        context = await getModelContext(modelId);
        const page = await context.newPage();

        console.log('🌐 Abrindo Reddit login...');

        // Navigate to Reddit login page
        await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(randomDelay(2000, 3000));

        console.log('📄 Página carregada, preenchendo formulário...');

        // Reddit has multiple possible login form layouts
        // Try to find username field with various selectors
        const usernameSelectors = [
            '#login-username',
            'input[name="username"]',
            'input[id="loginUsername"]',
            'faceplate-text-input[name="username"] input',
            'input[autocomplete="username"]',
        ];

        let usernameField = null;
        for (const sel of usernameSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                usernameField = el;
                console.log(`  ✅ Username field: ${sel}`);
                break;
            }
        }

        if (!usernameField) {
            // Take screenshot for debugging
            const screenshotPath = path.join(COOKIES_DIR, `debug_login_${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath });
            console.log(`📸 Screenshot salvo: ${screenshotPath}`);
            await page.close();
            return { success: false, error: 'Could not find username field on login page' };
        }

        await usernameField.click();
        await usernameField.fill(username);
        await page.waitForTimeout(randomDelay(500, 800));

        // Find password field
        const passwordSelectors = [
            '#login-password',
            'input[name="password"]',
            'input[id="loginPassword"]',
            'faceplate-text-input[name="password"] input',
            'input[type="password"]',
        ];

        let passwordField = null;
        for (const sel of passwordSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                passwordField = el;
                console.log(`  ✅ Password field: ${sel}`);
                break;
            }
        }

        if (!passwordField) {
            await page.close();
            return { success: false, error: 'Could not find password field' };
        }

        await passwordField.click();
        await passwordField.fill(password);
        await page.waitForTimeout(randomDelay(500, 800));

        console.log('🔐 Clicando login...');

        // Find and click submit button
        const submitSelectors = [
            'button[type="submit"]',
            'button.login',
            'button:has-text("Log In")',
            'button:has-text("Sign In")',
            'button:has-text("Entrar")',
            'faceplate-tracker button',
        ];

        let submitted = false;
        for (const sel of submitSelectors) {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                await el.click();
                submitted = true;
                console.log(`  ✅ Submit button: ${sel}`);
                break;
            }
        }

        // If no button found, try pressing Enter on the password field
        if (!submitted) {
            console.log('  ⚠️ No submit button, pressing Enter...');
            await passwordField!.press('Enter');
        }

        // Wait for navigation/login to complete
        await page.waitForTimeout(randomDelay(5000, 7000));

        // Check if login was successful
        const currentUrl = page.url();
        console.log(`📍 URL após login: ${currentUrl}`);

        if (currentUrl.includes('login') || currentUrl.includes('register')) {
            const screenshotPath = path.join(COOKIES_DIR, `debug_login_fail_${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath });
            console.log(`📸 Screenshot: ${screenshotPath}`);
            await page.close();
            return { success: false, error: 'Login failed — check credentials or CAPTCHA' };
        }

        // Save session
        await saveSession(modelId, context);

        // Update DB with Reddit username
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

        // Navigate to subreddit submission page
        await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(randomDelay(2000, 3000));

        // Check if logged in
        if (page.url().includes('login')) {
            fs.unlinkSync(tempImagePath);
            await page.close();
            await context.close();
            return { success: false, error: 'Session expired — need to login again' };
        }

        // Switch to "Images & Video" tab
        const imageTab = page.locator('button:has-text("Images"), button:has-text("Image"), button:has-text("Media")');
        if (await imageTab.isVisible()) {
            await imageTab.click();
            await page.waitForTimeout(randomDelay(500, 1000));
        }

        // Upload image via file input
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tempImagePath);
        await page.waitForTimeout(randomDelay(3000, 5000)); // Wait for upload

        // Fill title
        const titleInput = page.locator('textarea[placeholder*="Title"], input[placeholder*="Title"], [data-test-id="post-title"] textarea');
        await titleInput.fill(title);
        await page.waitForTimeout(randomDelay(500, 1000));

        // Mark NSFW
        if (isNsfw) {
            const nsfwButton = page.locator('button:has-text("NSFW"), button:has-text("nsfw")');
            if (await nsfwButton.isVisible()) {
                await nsfwButton.click();
                await page.waitForTimeout(randomDelay(300, 500));
            }
        }

        // Submit post
        const submitButton = page.locator('button:has-text("Post"), button:has-text("Submit"), button[type="submit"]').last();
        await submitButton.click();
        await page.waitForTimeout(randomDelay(4000, 6000));

        // Get the post URL
        const postUrl = page.url();

        // Delete temp image
        fs.unlinkSync(tempImagePath);

        // Save to database
        const supabase = getSupabaseAdmin();
        await supabase.from('posts').insert({
            model_id: modelId,
            platform: 'reddit',
            post_type: 'image',
            content: title,
            subreddit,
            external_url: postUrl,
            status: 'published',
            published_at: new Date().toISOString(),
            metadata: { image_url: imageUrl },
        });

        await saveSession(modelId, context);
        await page.close();

        return { success: true, url: postUrl };

    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ Reddit image post error:', errMsg);
        return { success: false, error: errMsg };
    } finally {
        if (context) await context.close();
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
