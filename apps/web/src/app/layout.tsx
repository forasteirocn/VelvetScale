import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'VelvetScale — AI Social Media Manager for Models',
    description: 'Agentes de IA autônomos que gerenciam suas redes sociais. Reddit, Twitter/X, tudo no piloto automático via WhatsApp.',
    keywords: ['social media', 'AI agent', 'content creator', 'OnlyFans', 'Reddit', 'automation'],
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
