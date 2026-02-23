import Link from 'next/link';

export default function HomePage() {
    return (
        <div>
            {/* Navigation */}
            <header className="container">
                <nav className="navbar">
                    <Link href="/" className="navbar-brand">
                        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                            <defs>
                                <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                                    <stop stopColor="#8B5CF6" />
                                    <stop offset="1" stopColor="#F472B6" />
                                </linearGradient>
                            </defs>
                            <rect width="32" height="32" rx="8" fill="url(#logo-grad)" />
                            <path d="M10 22V12l6 5 6-5v10" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>VelvetScale</span>
                    </Link>
                    <div className="navbar-links">
                        <Link href="/login" className="btn btn-secondary">Entrar</Link>
                        <Link href="/register" className="btn btn-primary">Começar agora</Link>
                    </div>
                </nav>
            </header>

            {/* Hero */}
            <section className="hero">
                <div className="hero-content animate-in">
                    <h1>
                        Suas redes sociais no <span className="gradient-text">piloto automático</span>
                    </h1>
                    <p>
                        Agentes de IA autônomos que postam, engajam e promovem seu perfil no Reddit e Twitter/X.
                        Tudo com um simples comando no WhatsApp.
                    </p>
                    <div className="hero-cta">
                        <Link href="/register" className="btn btn-primary btn-lg">
                            Começar gratuitamente
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </Link>
                        <Link href="#features" className="btn btn-secondary btn-lg">
                            Como funciona
                        </Link>
                    </div>
                </div>
            </section>

            {/* Features */}
            <section className="features container" id="features">
                <h2>Tudo que você precisa para <span className="gradient-text">escalar</span></h2>

                <div className="features-grid">
                    <div className="feature-card animate-in">
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#25D366" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                            </svg>
                        </div>
                        <h3>Comandos via WhatsApp</h3>
                        <p>
                            Envie uma mensagem no WhatsApp e seu agente de IA cuida do resto.
                            &quot;Poste algo divertido no Reddit&quot; — e pronto!
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.1s' }}>
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FF4500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" />
                                <circle cx="12" cy="12" r="4" />
                                <line x1="12" y1="2" x2="12" y2="4" />
                                <line x1="12" y1="20" x2="12" y2="22" />
                            </svg>
                        </div>
                        <h3>Reddit Inteligente</h3>
                        <p>
                            O agente encontra os melhores subreddits, cria posts que parecem naturais
                            e engaja com os comentários para maximizar visibilidade.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.2s' }}>
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                            </svg>
                        </div>
                        <h3>IA Claude de Ponta</h3>
                        <p>
                            Powered by Claude da Anthropic — gera conteúdo autêntico, entende contexto,
                            e nunca parece um bot. Cada post é único.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.3s' }}>
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1DA1F2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2c9 5 20 0 20-11.5 0-.28-.03-.56-.08-.83A7.72 7.72 0 0023 3z" />
                            </svg>
                        </div>
                        <h3>Twitter/X (Em breve)</h3>
                        <p>
                            Tweets, threads e engajamento automático.
                            Expanda sua presença em múltiplas plataformas ao mesmo tempo.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.4s' }}>
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="20" x2="18" y2="10" />
                                <line x1="12" y1="20" x2="12" y2="4" />
                                <line x1="6" y1="20" x2="6" y2="14" />
                            </svg>
                        </div>
                        <h3>Analytics em Tempo Real</h3>
                        <p>
                            Acompanhe engajamento, melhores horários de postagem,
                            e performance de cada subreddit no seu dashboard.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.5s' }}>
                        <div className="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F472B6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                            </svg>
                        </div>
                        <h3>Seguro e Discreto</h3>
                        <p>
                            Seus dados e credenciais são criptografados.
                            O agente age de forma natural, sem levantar suspeitas.
                        </p>
                    </div>
                </div>
            </section>

            {/* How it Works */}
            <section className="features container" style={{ paddingTop: '60px' }}>
                <h2>Como funciona em <span className="gradient-text">3 passos</span></h2>

                <div className="features-grid" style={{ maxWidth: '900px', margin: '0 auto' }}>
                    <div className="card animate-in" style={{ textAlign: 'center', padding: '40px 24px' }}>
                        <div style={{ fontSize: '48px', marginBottom: '16px', fontWeight: 800 }} className="gradient-text">1</div>
                        <h3 style={{ marginBottom: '12px', fontSize: '18px' }}>Conecte suas contas</h3>
                        <p style={{ color: 'var(--vs-text-secondary)', fontSize: '14px' }}>
                            Vincule seu Reddit e/ou Twitter ao VelvetScale em poucos cliques.
                        </p>
                    </div>

                    <div className="card animate-in" style={{ textAlign: 'center', padding: '40px 24px', animationDelay: '0.15s' }}>
                        <div style={{ fontSize: '48px', marginBottom: '16px', fontWeight: 800 }} className="gradient-text">2</div>
                        <h3 style={{ marginBottom: '12px', fontSize: '18px' }}>Configure seu perfil</h3>
                        <p style={{ color: 'var(--vs-text-secondary)', fontSize: '14px' }}>
                            Adicione sua bio, links e persona. O agente vai falar como você.
                        </p>
                    </div>

                    <div className="card animate-in" style={{ textAlign: 'center', padding: '40px 24px', animationDelay: '0.3s' }}>
                        <div style={{ fontSize: '48px', marginBottom: '16px', fontWeight: 800 }} className="gradient-text">3</div>
                        <h3 style={{ marginBottom: '12px', fontSize: '18px' }}>Mande um WhatsApp</h3>
                        <p style={{ color: 'var(--vs-text-secondary)', fontSize: '14px' }}>
                            &quot;Poste no Reddit&quot;, &quot;Encontre subreddits&quot;, &quot;Estatísticas&quot; — e pronto!
                        </p>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section style={{ padding: '120px 0', textAlign: 'center' }}>
                <div className="container">
                    <h2 style={{ fontSize: '36px', fontWeight: 800, marginBottom: '20px' }}>
                        Pronta para <span className="gradient-text">escalar</span>?
                    </h2>
                    <p style={{ color: 'var(--vs-text-secondary)', maxWidth: '500px', margin: '0 auto 32px', fontSize: '16px' }}>
                        Junte-se às modelos que já estão usando IA para crescer nas redes sociais.
                    </p>
                    <Link href="/register" className="btn btn-primary btn-lg">
                        Comece agora — é grátis para testar
                    </Link>
                </div>
            </section>

            {/* Footer */}
            <footer style={{ borderTop: '1px solid var(--vs-border)', padding: '32px 0' }}>
                <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--vs-text-muted)', fontSize: '14px' }}>
                        © 2026 VelvetScale. Todos os direitos reservados.
                    </span>
                    <div style={{ display: 'flex', gap: '24px' }}>
                        <Link href="/terms" style={{ color: 'var(--vs-text-muted)', fontSize: '14px', textDecoration: 'none' }}>Termos</Link>
                        <Link href="/privacy" style={{ color: 'var(--vs-text-muted)', fontSize: '14px', textDecoration: 'none' }}>Privacidade</Link>
                    </div>
                </div>
            </footer>
        </div>
    );
}
