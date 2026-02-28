import Link from 'next/link';
import Image from 'next/image';

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
                        <Link href="#features" className="btn btn-secondary">Features</Link>
                        <Link href="#pricing" className="btn btn-primary">Começar agora</Link>
                    </div>
                </nav>
            </header>

            {/* Hero */}
            <section className="hero container">
                <div className="animate-in">
                    <div className="hero-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        Powered by AI
                    </div>
                    <h1>
                        Seu Twitter no <span className="gradient-text">piloto automático</span>
                    </h1>
                    <p>
                        Um agente de IA que fala como você, posta como você e engaja como você —
                        24 horas por dia, 7 dias por semana.
                    </p>
                    <div className="hero-cta">
                        <Link href="#pricing" className="btn btn-primary btn-lg">
                            Começar agora
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </Link>
                        <Link href="#features" className="btn btn-secondary btn-lg">
                            Como funciona
                        </Link>
                    </div>
                </div>
            </section>

            {/* Engagement Chart */}
            <section className="chart-section container">
                <div className="chart-wrapper animate-in" style={{ animationDelay: '0.2s' }}>
                    <Image
                        src="/engagement-chart.png"
                        alt="Gráfico mostrando crescimento de engajamento no Twitter com VelvetScale"
                        width={680}
                        height={680}
                        priority
                    />
                </div>
                <p className="chart-caption">
                    Dados de uma criadora real após 3 meses usando VelvetScale
                </p>
            </section>

            {/* Features */}
            <section className="features-section container" id="features">
                <div className="section-header">
                    <h2>Tudo que seu Twitter <span className="gradient-text">precisa</span></h2>
                    <p>Um agente inteligente que nunca dorme e sempre entende seu estilo</p>
                </div>

                <div className="features-grid">
                    <div className="feature-card animate-in">
                        <div className="feature-icon feature-icon-purple">🤖</div>
                        <h3>Personalidade Customizável</h3>
                        <p>
                            Defina o tom de voz, estilo e personalidade do agente.
                            Ele vai falar exatamente como você — ninguém percebe a diferença.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.1s' }}>
                        <div className="feature-icon feature-icon-blue">📝</div>
                        <h3>Posts Automáticos</h3>
                        <p>
                            Tweets, threads e conteúdo de presença publicados nos melhores horários.
                            O agente aprende quando sua audiência está ativa.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.2s' }}>
                        <div className="feature-icon feature-icon-green">💬</div>
                        <h3>Respostas Inteligentes</h3>
                        <p>
                            Responde menções automaticamente com a sua vibe.
                            Seus seguidores recebem atenção em segundos, não horas.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.3s' }}>
                        <div className="feature-icon feature-icon-orange">🔥</div>
                        <h3>Detector de Trends</h3>
                        <p>
                            O agente monitora tendências em tempo real e cria posts relevantes.
                            Nunca mais perca uma trend que poderia viralizar.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.4s' }}>
                        <div className="feature-icon feature-icon-cyan">📊</div>
                        <h3>Aprendizado Contínuo</h3>
                        <p>
                            Analisa quais posts performam melhor e adapta a estratégia.
                            Quanto mais usa, mais inteligente ele fica.
                        </p>
                    </div>

                    <div className="feature-card animate-in" style={{ animationDelay: '0.5s' }}>
                        <div className="feature-icon feature-icon-pink">🛡️</div>
                        <h3>Seguro e Natural</h3>
                        <p>
                            Age de forma 100% natural — nunca parece um bot.
                            Seus dados e credenciais são protegidos com criptografia.
                        </p>
                    </div>
                </div>
            </section>

            {/* AI vs Human */}
            <section className="comparison-section">
                <div className="container">
                    <div className="section-header">
                        <h2>Por que IA e não um <span className="gradient-text">humano</span>?</h2>
                        <p>Um social media manager humano custa de $500 a $2.000/mês e trabalha 8 horas</p>
                    </div>
                    <div className="comparison-wrapper animate-in">
                        <Image
                            src="/ai-vs-human.png"
                            alt="Comparação entre agente de IA VelvetScale e gerente humano"
                            width={600}
                            height={600}
                        />
                    </div>
                </div>
            </section>

            {/* How it Works */}
            <section className="steps-section container">
                <div className="section-header">
                    <h2>Funciona em <span className="gradient-text">3 passos</span></h2>
                    <p>Configure uma vez e deixe a IA trabalhar por você</p>
                </div>

                <div className="steps-grid">
                    <div className="step-card animate-in">
                        <div className="step-number gradient-text">1</div>
                        <h3>Conecte seu Twitter</h3>
                        <p>Vincule sua conta com um clique. Sem senhas salvas, apenas autorização OAuth segura.</p>
                    </div>

                    <div className="step-card animate-in" style={{ animationDelay: '0.15s' }}>
                        <div className="step-number gradient-text">2</div>
                        <h3>Defina sua personalidade</h3>
                        <p>Escreva como você fala, seus interesses e estilo. O agente vai ser a sua versão digital.</p>
                    </div>

                    <div className="step-card animate-in" style={{ animationDelay: '0.3s' }}>
                        <div className="step-number gradient-text">3</div>
                        <h3>Relaxe e cresça</h3>
                        <p>O agente posta, responde e engaja 24/7. Acompanhe tudo pelo painel ou Telegram.</p>
                    </div>
                </div>
            </section>

            {/* Pricing */}
            <section className="pricing-section" id="pricing">
                <div className="container">
                    <div className="section-header">
                        <h2>Planos <span className="gradient-text">simples</span></h2>
                        <p>Sem surpresas. Cancele quando quiser.</p>
                    </div>

                    <div className="pricing-grid">
                        {/* Starter */}
                        <div className="pricing-card">
                            <h3>Starter</h3>
                            <p style={{ color: 'var(--vs-text-secondary)', fontSize: '14px' }}>Ideal para começar</p>
                            <div className="pricing-price">
                                $49<span>/mês</span>
                            </div>
                            <ul className="pricing-features">
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    1 conta Twitter
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Posts automáticos diários
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Respostas a menções
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Detector de trends
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Personalidade customizável
                                </li>
                            </ul>
                            <Link href="#" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }}>
                                Escolher Starter
                            </Link>
                        </div>

                        {/* Pro */}
                        <div className="pricing-card featured">
                            <div className="pricing-badge">Mais popular</div>
                            <h3>Pro</h3>
                            <p style={{ color: 'var(--vs-text-secondary)', fontSize: '14px' }}>Para quem quer o máximo</p>
                            <div className="pricing-price">
                                $99<span>/mês</span>
                            </div>
                            <ul className="pricing-features">
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Twitter + Reddit
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Tudo do Starter
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Analytics avançado
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Suporte prioritário
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Estratégia de crescimento
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                                    Dashboard dedicado
                                </li>
                            </ul>
                            <Link href="#" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                                Escolher Pro
                            </Link>
                        </div>
                    </div>
                </div>
            </section>

            {/* CTA Final */}
            <section className="cta-section container">
                <h2>
                    Pronta para <span className="gradient-text">escalar</span>?
                </h2>
                <p>
                    Junte-se às criadoras que já estão usando IA para crescer no Twitter.
                    Configure em menos de 5 minutos.
                </p>
                <Link href="#pricing" className="btn btn-primary btn-lg">
                    Comece agora — teste grátis por 7 dias
                </Link>
            </section>

            {/* Footer */}
            <footer className="footer">
                <div className="container footer-inner">
                    <span style={{ color: 'var(--vs-text-muted)', fontSize: '14px' }}>
                        © 2026 VelvetScale. Todos os direitos reservados.
                    </span>
                    <div className="footer-links">
                        <Link href="/terms">Termos</Link>
                        <Link href="/privacy">Privacidade</Link>
                        <a href="mailto:support@velvetscale.com">Contato</a>
                    </div>
                </div>
            </footer>
        </div>
    );
}
