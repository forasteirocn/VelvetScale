const { Queue } = require('bullmq');
const IORedis = require('ioredis');

async function clear() {
    const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    const postQueue = new Queue('posts', { connection });
    await postQueue.obliterate({ force: true });
    console.log('🗑️ Post queue obliterated');
    
    // Also clear specific bull keys
    const keys = await connection.keys('bull:*');
    if (keys.length > 0) {
        await connection.del(keys);
        console.log(`🗑️ Deleted ${keys.length} bull keys`);
    } else {
        console.log('🧹 Redis is clean');
    }
    
    process.exit(0);
}

clear().catch(console.error);
