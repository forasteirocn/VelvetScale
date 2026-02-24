import { getSupabaseAdmin } from '@velvetscale/db';
import { sendTelegramMessage } from './integrations/telegram';
import { analyzeImage, improveCaption, pickBestSubForCaption, type ImageAnalysis } from './integrations/claude';
import { validatePostBeforeSubmit } from './anti-ban';
import { getLearningSummary } from './learning';

// =============================================
// VelvetScale Autonomous Calendar
// Modelo envia 5-10 fotos → IA cria calendário semanal
// =============================================

// In-memory batch accumulator per model
const photoBatches: Map<string, {
    modelId: string;
    chatId: number;
    photos: Array<{ url: string; caption: string; fileId: string }>;
    timer: ReturnType<typeof setTimeout>;
}> = new Map();

const BATCH_WAIT_MS = 60_000; // Wait 60s after last photo for batch to "close"
const MAX_POSTS_PER_DAY = 4;
const MIN_HOURS_BETWEEN_POSTS = 4;

/**
 * Add a photo to the batch accumulator
 * After 30s of no new photos, the batch is processed
 */
export async function addPhotoToBatch(
    modelId: string,
    chatId: number,
    photoUrl: string,
    caption: string,
    fileId: string
): Promise<void> {
    const key = modelId;

    if (photoBatches.has(key)) {
        const batch = photoBatches.get(key)!;
        batch.photos.push({ url: photoUrl, caption, fileId });
        clearTimeout(batch.timer);

        // Reset timer
        batch.timer = setTimeout(() => processBatch(key), BATCH_WAIT_MS);

        const count = batch.photos.length;
        if (count <= 5) {
            await sendTelegramMessage(chatId, `📷 Foto ${count} recebida! Envie mais ou aguarde 1 min para criar o calendário.`);
        } else if (count === 28) {
            await sendTelegramMessage(chatId, `📷 Foto ${count} recebida! Você já tem fotos pra 7 dias completos (4/dia). Pode enviar mais se quiser.`);
        }
    } else {
        const timer = setTimeout(() => processBatch(key), BATCH_WAIT_MS);
        photoBatches.set(key, {
            modelId,
            chatId,
            photos: [{ url: photoUrl, caption, fileId }],
            timer,
        });

        await sendTelegramMessage(chatId,
            `📅 *Modo Piloto Automático ativado!*\n\n` +
            `Envie todas as fotos que quiser no próximo 1 minuto.\n` +
            `Depois que parar, eu crio um calendário semanal completo.\n\n` +
            `📷 Foto 1 recebida!`
        );
    }
}

/**
 * Check if a model is in batch/piloto mode
 */
export function isInBatchMode(modelId: string): boolean {
    return photoBatches.has(modelId);
}

/**
 * Process accumulated batch of photos into a weekly calendar
 */
async function processBatch(key: string): Promise<void> {
    const batch = photoBatches.get(key);
    if (!batch) return;

    photoBatches.delete(key);

    const { modelId, chatId, photos } = batch;
    const photoCount = photos.length;

    console.log(`📅 Processing batch: ${photoCount} photos for model ${modelId.substring(0, 8)}`);
    await sendTelegramMessage(chatId,
        `📅 Criando calendário com ${photoCount} foto(s)...\n` +
        `🧠 Analisando cada imagem com IA...`
    );

    const supabase = getSupabaseAdmin();

    // Get model info
    const { data: model } = await supabase
        .from('models')
        .select('*')
        .eq('id', modelId)
        .single();

    if (!model) {
        await sendTelegramMessage(chatId, '❌ Erro ao criar calendário.');
        return;
    }

    // Get available subs
    const { data: subs } = await supabase
        .from('subreddits')
        .select('name, engagement_score, cooldown_hours, last_posted_at')
        .eq('model_id', modelId)
        .eq('is_approved', true)
        .eq('is_banned', false);

    const subNames = subs?.map(s => s.name) || [];
    if (subNames.length === 0) {
        await sendTelegramMessage(chatId, '⚠️ Nenhum sub aprovado. Use /login reddit para importar.');
        return;
    }

    // Get learning context
    const learning = await getLearningSummary(modelId);

    // Analyze all photos with Claude Vision
    const analyses: Array<{
        photo: typeof photos[0];
        analysis: ImageAnalysis | null;
    }> = [];

    for (const photo of photos) {
        const analysis = await analyzeImage(photo.url);
        analyses.push({ photo, analysis });
    }

    // Calculate posting slots for the next 7 days
    // Distribute photos evenly: max 3/day, spaced 4+ hours apart
    const slots = generateCalendarSlots(photoCount);

    // Assign each photo to a slot with best-matching sub
    const assignments: Array<{
        photo: typeof photos[0];
        analysis: ImageAnalysis | null;
        sub: string;
        title: string;
        scheduledFor: Date;
    }> = [];

    const usedSubs = new Set<string>();

    for (let i = 0; i < Math.min(analyses.length, slots.length); i++) {
        const { photo, analysis } = analyses[i];
        const slot = slots[i];

        // Pick best sub (avoid repeating in same day)
        let bestSub: string;
        const availableForSlot = subNames.filter(s => !usedSubs.has(s));
        if (availableForSlot.length === 0) {
            usedSubs.clear(); // Reset when all used
            bestSub = subNames[Math.floor(Math.random() * subNames.length)];
        } else {
            bestSub = await pickBestSubForCaption(photo.caption || '🔥', availableForSlot, analysis);
        }
        usedSubs.add(bestSub);

        // Validate sub
        const validation = await validatePostBeforeSubmit(bestSub, photo.caption || '🔥', true, modelId);
        if (!validation.isOk) {
            // Pick another sub
            const fallback = subNames.find(s => s !== bestSub && !usedSubs.has(s));
            if (fallback) bestSub = fallback;
        }

        // Generate title
        let title = photo.caption || '🔥';
        try {
            const improved = await improveCaption(
                photo.caption || '🔥',
                bestSub,
                model.bio || '',
                model.persona || '',
                { onlyfans: model.onlyfans_url, privacy: model.privacy_url },
                analysis
            );
            title = improved.title;
        } catch { /* use original */ }

        assignments.push({
            photo,
            analysis,
            sub: bestSub,
            title,
            scheduledFor: slot,
        });
    }

    // Save all to scheduled_posts
    for (const assignment of assignments) {
        await supabase.from('scheduled_posts').insert({
            model_id: modelId,
            image_url: assignment.photo.url,
            original_caption: assignment.photo.caption || '',
            improved_title: assignment.title,
            target_subreddit: assignment.sub,
            scheduled_for: assignment.scheduledFor.toISOString(),
            status: 'queued',
            is_nsfw: true,
        });
    }

    // Send calendar summary to Telegram
    let calendarMsg = `📅 *Calendário criado! ${assignments.length} posts agendados:*\n\n`;

    // Group by day
    const byDay: Record<string, typeof assignments> = {};
    for (const a of assignments) {
        const dayKey = a.scheduledFor.toLocaleDateString('pt-BR', {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            timeZone: 'America/Sao_Paulo',
        });
        if (!byDay[dayKey]) byDay[dayKey] = [];
        byDay[dayKey].push(a);
    }

    for (const [day, posts] of Object.entries(byDay)) {
        calendarMsg += `*${day}:*\n`;
        for (const post of posts) {
            const time = post.scheduledFor.toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'America/Sao_Paulo',
            });
            const safeSub = post.sub.replace(/_/g, '\\_');
            const shortTitle = post.title.substring(0, 40);
            calendarMsg += `  ${time} → r/${safeSub}\n  "${shortTitle}"\n`;
        }
        calendarMsg += '\n';
    }

    calendarMsg += `Use /fila para ver detalhes. Os posts serão publicados automaticamente!`;

    await sendTelegramMessage(chatId, calendarMsg);

    // Log
    await supabase.from('agent_logs').insert({
        model_id: modelId,
        action: 'calendar_created',
        details: {
            photos: photoCount,
            scheduled: assignments.length,
            subs: [...new Set(assignments.map(a => a.sub))],
        },
    });

    console.log(`📅 Calendar created: ${assignments.length} posts for model ${modelId.substring(0, 8)}`);
}

/**
 * Generate posting slots spread across the next 7 days
 * Peak hours: 8-10am, 12-2pm, 6-8pm EST
 */
function generateCalendarSlots(photoCount: number): Date[] {
    const peakHoursEST = [8, 10, 12, 14, 18, 20];
    const slots: Date[] = [];
    const now = new Date();

    let dayOffset = 0;
    let hourIndex = 0;
    let dailyCount = 0;

    // Start from next available peak hour today
    const currentHourEST = (now.getUTCHours() - 5 + 24) % 24;
    const nextViableHours = peakHoursEST.filter(h => h > currentHourEST + 1);
    if (nextViableHours.length > 0) {
        hourIndex = peakHoursEST.indexOf(nextViableHours[0]);
    } else {
        dayOffset = 1;
        hourIndex = 0;
    }

    while (slots.length < photoCount && dayOffset < 14) {
        if (dailyCount >= MAX_POSTS_PER_DAY) {
            dayOffset++;
            dailyCount = 0;
            hourIndex = 0;
        }

        if (hourIndex >= peakHoursEST.length) {
            dayOffset++;
            dailyCount = 0;
            hourIndex = 0;
            continue;
        }

        const slotDate = new Date(now);
        slotDate.setDate(slotDate.getDate() + dayOffset);

        // Convert EST hour to UTC
        const utcHour = (peakHoursEST[hourIndex] + 5) % 24;
        slotDate.setUTCHours(utcHour, Math.floor(Math.random() * 30), 0, 0);

        // Add some randomness (±15 min)
        slotDate.setMinutes(slotDate.getMinutes() + Math.floor(Math.random() * 30) - 15);

        slots.push(slotDate);
        hourIndex += 2; // Skip every other hour for spacing
        dailyCount++;
    }

    return slots;
}
