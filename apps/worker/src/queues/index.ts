import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { processCommandJob } from './processors/command';
import { processPostJob } from './processors/post';
import { processDiscoveryJob } from './processors/discovery';

let connection: IORedis | null = null;

export let commandQueue: Queue;
export let postQueue: Queue;
export let discoveryQueue: Queue;

/**
 * Initialize all BullMQ queues and workers
 */
export async function initQueues(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    // --- Command Queue (WhatsApp messages) ---
    commandQueue = new Queue('commands', { connection });
    new Worker('commands', processCommandJob, {
        connection,
        concurrency: 5,
        limiter: { max: 10, duration: 60000 }, // Max 10 per minute
    });

    // --- Post Queue (scheduled/immediate posts) ---
    postQueue = new Queue('posts', { connection });
    new Worker('posts', processPostJob, {
        connection,
        concurrency: 3,
        limiter: { max: 5, duration: 60000 },
    });

    // --- Discovery Queue (subreddit discovery) ---
    discoveryQueue = new Queue('discovery', { connection });
    new Worker('discovery', processDiscoveryJob, {
        connection,
        concurrency: 2,
        limiter: { max: 3, duration: 60000 },
    });

    console.log('📋 Queues: commands, posts, discovery');
}
