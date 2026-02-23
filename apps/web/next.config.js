/** @type {import('next').NextConfig} */
const nextConfig = {
    transpilePackages: ['@velvetscale/shared'],
    env: {
        NEXT_PUBLIC_API_URL: process.env.API_URL || 'http://localhost:3001',
    },
};

module.exports = nextConfig;
