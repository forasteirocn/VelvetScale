import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'VelvetScale — AI Agent for Twitter | Seu Twitter no Piloto Automático',
    description: 'Agente de IA que gerencia seu Twitter 24/7. Posts automáticos, respostas a menções, detector de trends — tudo com a sua personalidade. Para criadoras de conteúdo.',
    keywords: ['twitter automation', 'AI agent', 'content creator', 'social media manager', 'twitter bot', 'engagement', 'VelvetScale'],
    openGraph: {
        title: 'VelvetScale — Seu Twitter no Piloto Automático',
        description: 'Um agente de IA ultra-inteligente que cuida do seu Twitter 24h por dia.',
        siteName: 'VelvetScale',
        type: 'website',
        url: 'https://velvetscale.com',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'VelvetScale — AI Agent for Twitter',
        description: 'Seu Twitter no piloto automático com IA.',
    },
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="pt-BR">
            <body>{children}</body>
        </html>
    );
}
