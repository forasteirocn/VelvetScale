'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Stats {
    totalPosts: number;
    publishedPosts: number;
    failedPosts: number;
    totalCommands: number;
    approvedSubreddits: number;
}

interface ActivityItem {
    id: string;
    platform?: string;
    post_type?: string;
    content?: string;
    subreddit?: string;
    status?: string;
    published_at?: string;
    created_at: string;
    action?: string;
    raw_message?: string;
    parsed_intent?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Placeholder model ID — will be replaced with auth
const MODEL_ID = 'demo';

export default function DashboardPage() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [posts, setPosts] = useState<ActivityItem[]>([]);
    const [commands, setCommands] = useState<ActivityItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function loadData() {
            try {
                const [statsRes, activityRes] = await Promise.all([
                    fetch(`${API_URL}/api/models/${MODEL_ID}/stats`),
                    fetch(`${API_URL}/api/models/${MODEL_ID}/activity`),
                ]);

                if (statsRes.ok) {
                    const statsData = await statsRes.json();
                    setStats(statsData.data);
                }

                if (activityRes.ok) {
                    const activityData = await activityRes.json();
                    setPosts(activityData.data.posts || []);
                    setCommands(activityData.data.commands || []);
                }
            } catch (error) {
                console.error('Failed to load dashboard data:', error);
            } finally {
                setLoading(false);
            }
        }

        loadData();
    }, []);

    function formatTime(dateStr: string) {
        const date = new Date(dateStr);
        const diff = Date.now() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        if (minutes < 60) return `${minutes}m atrás`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h atrás`;
        return `${Math.floor(hours / 24)}d atrás`;
    }

    return (
        <div className="dashboard">
            {/* Sidebar */}
            <aside className="sidebar">
                <Link href="/" className="navbar-brand" style={{ marginBottom: '32px', fontSize: '18px' }}>
                    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                        <defs>
                            <linearGradient id="sb-logo" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                                <stop stopColor="#8B5CF6" />
                                <stop offset="1" stopColor="#F472B6" />
                            </linearGradient>
                        </defs>
                        <rect width="32" height="32" rx="8" fill="url(#sb-logo)" />
                        <path d="M10 22V12l6 5 6-5v10" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>VelvetScale</span>
                </Link>

                <Link href="/dashboard" className="sidebar-link active">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                    </svg>
                    Dashboard
                </Link>

                <Link href="/dashboard/subreddits" className="sidebar-link">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
                    </svg>
                    Subreddits
                </Link>

                <Link href="/dashboard/posts" className="sidebar-link">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    Posts
                </Link>

                <Link href="/dashboard/accounts" className="sidebar-link">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
                    </svg>
                    Contas
                </Link>

                <Link href="/dashboard/settings" className="sidebar-link">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                    </svg>
                    Configurações
                </Link>
            </aside>

            {/* Main Content */}
            <main className="main-content">
                <div className="page-header">
                    <h1>Dashboard</h1>
                    <p>Visão geral da atividade do seu agente de IA</p>
                </div>

                {/* Stats */}
                <div className="stats-grid">
                    <div className="stat-card animate-in">
                        <span className="stat-label">Posts Publicados</span>
                        <span className="stat-value">
                            {loading ? <span className="skeleton" style={{ width: 60, height: 32, display: 'block' }} /> : stats?.publishedPosts || 0}
                        </span>
                    </div>
                    <div className="stat-card animate-in" style={{ animationDelay: '0.1s' }}>
                        <span className="stat-label">Comandos</span>
                        <span className="stat-value">
                            {loading ? <span className="skeleton" style={{ width: 60, height: 32, display: 'block' }} /> : stats?.totalCommands || 0}
                        </span>
                    </div>
                    <div className="stat-card animate-in" style={{ animationDelay: '0.2s' }}>
                        <span className="stat-label">Subreddits</span>
                        <span className="stat-value">
                            {loading ? <span className="skeleton" style={{ width: 60, height: 32, display: 'block' }} /> : stats?.approvedSubreddits || 0}
                        </span>
                    </div>
                    <div className="stat-card animate-in" style={{ animationDelay: '0.3s' }}>
                        <span className="stat-label">Falhas</span>
                        <span className="stat-value">
                            {loading ? <span className="skeleton" style={{ width: 60, height: 32, display: 'block' }} /> : stats?.failedPosts || 0}
                        </span>
                    </div>
                </div>

                {/* Activity Feed & Subreddits */}
                <div className="two-col">
                    {/* Recent Posts */}
                    <div className="card">
                        <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 700 }}>Posts Recentes</h3>
                        {loading ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                {[1, 2, 3].map(i => (
                                    <div key={i} className="skeleton" style={{ height: 60 }} />
                                ))}
                            </div>
                        ) : posts.length === 0 ? (
                            <p style={{ color: 'var(--vs-text-muted)', fontSize: '14px', padding: '20px 0', textAlign: 'center' }}>
                                Nenhum post ainda. Envie um comando no WhatsApp para começar!
                            </p>
                        ) : (
                            posts.slice(0, 5).map((post) => (
                                <div key={post.id} className="activity-item">
                                    <div className={`activity-icon ${post.platform}`}>
                                        {post.platform === 'reddit' ? 'R' : 'X'}
                                    </div>
                                    <div className="activity-content">
                                        <div className="activity-title">
                                            {post.subreddit ? `r/${post.subreddit}` : 'Tweet'}
                                        </div>
                                        <div className="activity-detail">
                                            {post.content?.substring(0, 80)}...
                                        </div>
                                    </div>
                                    <div>
                                        <span className={`badge badge-${post.status === 'published' ? 'success' : post.status === 'failed' ? 'error' : 'warning'}`}>
                                            {post.status}
                                        </span>
                                        <div className="activity-time" style={{ marginTop: '4px' }}>
                                            {formatTime(post.created_at)}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Recent Commands */}
                    <div className="card">
                        <h3 style={{ marginBottom: '16px', fontSize: '16px', fontWeight: 700 }}>Últimos Comandos</h3>
                        {loading ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                {[1, 2, 3].map(i => (
                                    <div key={i} className="skeleton" style={{ height: 60 }} />
                                ))}
                            </div>
                        ) : commands.length === 0 ? (
                            <p style={{ color: 'var(--vs-text-muted)', fontSize: '14px', padding: '20px 0', textAlign: 'center' }}>
                                Nenhum comando recebido. Envie uma mensagem no WhatsApp!
                            </p>
                        ) : (
                            commands.slice(0, 5).map((cmd) => (
                                <div key={cmd.id} className="activity-item">
                                    <div className="activity-icon whatsapp">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#25D366" strokeWidth="2">
                                            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                                        </svg>
                                    </div>
                                    <div className="activity-content">
                                        <div className="activity-title">{cmd.raw_message?.substring(0, 50)}</div>
                                        <div className="activity-detail">
                                            Intent: {cmd.parsed_intent || 'processando...'}
                                        </div>
                                    </div>
                                    <div>
                                        <span className={`badge badge-${cmd.status === 'completed' ? 'success' : cmd.status === 'failed' ? 'error' : 'info'}`}>
                                            {cmd.status}
                                        </span>
                                        <div className="activity-time" style={{ marginTop: '4px' }}>
                                            {formatTime(cmd.created_at)}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
