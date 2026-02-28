import Link from 'next/link';

export default function HomePage() {
    return (
        <div>
            {/* Navigation */}
            <header className="container">
                <nav className="navbar">
                    <Link href="/" className="navbar-brand">
                        <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
                            <defs>
                                <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                                    <stop stopColor="#8B5CF6" />
                                    <stop offset="1" stopColor="#F472B6" />
                                </linearGradient>
                            </defs>
                            <rect width="32" height="32" rx="8" fill="url(#lg)" />
                            <path d="M10 22V12l6 5 6-5v10" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>VelvetScale</span>
                    </Link>
                    <div className="navbar-links">
                        <Link href="#features" className="btn btn-ghost">Features</Link>
                        <Link href="#pricing" className="btn btn-ghost">Preços</Link>
                        <Link href="#pricing" className="btn btn-primary">Teste grátis</Link>
                    </div>
                </nav>
            </header>

            {/* Hero */}
            <section className="hero container">
                <div className="ani">
                    <div className="hero-badge">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        Powered by AI
                    </div>
                    <h1>
                        Seu Twitter no<br />
                        <span className="gradient-text">piloto automático</span>
                    </h1>
                    <p>
                        Um agente de IA que fala como você, posta como você
                        e engaja como você — 24 horas por dia.
                    </p>
                    <p className="hero-trial">✓ 30 dias grátis · Sem cartão de crédito</p>
                    <div className="hero-cta">
                        <Link href="#pricing" className="btn btn-primary btn-lg">
                            Começar grátis
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12h14M12 5l7 7-7 7" />
                            </svg>
                        </Link>
                        <Link href="#features" className="btn btn-outline btn-lg">
                            Ver features
                        </Link>
                    </div>
                </div>
            </section>

            {/* Stats Bar */}
            <section className="stats-bar container">
                <div className="stats-grid">
                    <div className="stat-card ani ani-1">
                        <div className="stat-value up">+340%</div>
                        <div className="stat-label">Impressões</div>
                    </div>
                    <div className="stat-card ani ani-2">
                        <div className="stat-value up">+127%</div>
                        <div className="stat-label">Novos seguidores</div>
                    </div>
                    <div className="stat-card ani ani-3">
                        <div className="stat-value up">+580%</div>
                        <div className="stat-label">Respostas</div>
                    </div>
                    <div className="stat-card ani ani-4">
                        <div className="stat-value up">4.8%</div>
                        <div className="stat-label">Taxa de engajamento</div>
                    </div>
                </div>
            </section>

            {/* Features */}
            <section className="section container" id="features">
                <div className="section-header">
                    <h2>Tudo que seu Twitter <span className="gradient-text">precisa</span></h2>
                    <p>6 módulos de IA trabalhando juntos, 24 horas por dia</p>
                </div>

                <div className="features-grid">
                    <div className="feature-card ani">
                        <span className="feature-emoji">🎭</span>
                        <h3>Personalidade Sob Medida</h3>
                        <p>
                            Defina tom de voz, estilo e personalidade. O agente fala
                            exatamente como você — ninguém percebe a diferença.
                        </p>
                    </div>
                    <div className="feature-card ani ani-1">
                        <span className="feature-emoji">📝</span>
                        <h3>Posts Inteligentes</h3>
                        <p>
                            Tweets e threads publicados nos melhores horários.
                            Conteúdo autêntico que gera engajamento real.
                        </p>
                    </div>
                    <div className="feature-card ani ani-2">
                        <span className="feature-emoji">💬</span>
                        <h3>Respostas a Menções</h3>
                        <p>
                            Responde automaticamente com a sua vibe. Seus seguidores
                            recebem atenção em segundos, não em horas.
                        </p>
                    </div>
                    <div className="feature-card ani ani-3">
                        <span className="feature-emoji">🔥</span>
                        <h3>Detector de Trends</h3>
                        <p>
                            Monitora tendências em tempo real e cria posts relevantes.
                            Nunca mais perca uma trend que poderia viralizar.
                        </p>
                    </div>
                    <div className="feature-card ani ani-4">
                        <span className="feature-emoji">🧠</span>
                        <h3>Aprendizado Contínuo</h3>
                        <p>
                            Analisa quais posts performam melhor e adapta a estratégia.
                            Quanto mais usa, mais inteligente ele fica.
                        </p>
                    </div>
                    <div className="feature-card ani ani-5">
                        <span className="feature-emoji">🛡️</span>
                        <h3>100% Natural</h3>
                        <p>
                            Nunca parece um bot. Cada post é único, contextual e
                            autêntico. Seus dados são protegidos com criptografia.
                        </p>
                    </div>
                </div>
            </section>

            {/* Comparison */}
            <section className="section section-alt">
                <div className="container">
                    <div className="section-header">
                        <h2>IA vs agente <span className="gradient-text">humano</span></h2>
                        <p>Por uma fração do custo, com 10x mais eficiência</p>
                    </div>

                    <div className="comparison-table ani">
                        <div className="comparison-header">
                            <div></div>
                            <div className="col-ai">⚡ VelvetScale</div>
                            <div className="col-human">👤 Humano</div>
                        </div>

                        <div className="comparison-row">
                            <div>Custo mensal</div>
                            <div><span className="check">$49/mês</span></div>
                            <div><span className="cross">$500–2.000/mês</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Disponibilidade</div>
                            <div><span className="check">24/7</span></div>
                            <div><span className="cross">8h/dia</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Tempo de resposta</div>
                            <div><span className="check">Segundos</span></div>
                            <div><span className="cross">Minutos a horas</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Trends em tempo real</div>
                            <div><span className="check">✓ Automático</span></div>
                            <div><span className="cross">✗ Pode perder</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Aprende seu estilo</div>
                            <div><span className="check">✓ Instantâneo</span></div>
                            <div><span className="cross">✗ Semanas</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Volume de posts</div>
                            <div><span className="check">Ilimitado</span></div>
                            <div><span className="cross">Limitado</span></div>
                        </div>
                        <div className="comparison-row">
                            <div>Consistência</div>
                            <div><span className="check">✓ Sempre</span></div>
                            <div><span className="cross">✗ Varia</span></div>
                        </div>
                    </div>
                </div>
            </section>

            {/* How it Works */}
            <section className="section container">
                <div className="section-header">
                    <h2>Funciona em <span className="gradient-text">3 passos</span></h2>
                    <p>Configure uma vez e nunca mais se preocupe</p>
                </div>

                <div className="steps-grid">
                    <div className="step-card ani">
                        <div className="step-number">1</div>
                        <h3>Conecte seu Twitter</h3>
                        <p>Autorização OAuth segura. Sem senhas salvas, login em um clique.</p>
                    </div>
                    <div className="step-card ani ani-1">
                        <div className="step-number">2</div>
                        <h3>Defina a personalidade</h3>
                        <p>Descreva como você fala, seus interesses e estilo. O agente vira a sua versão digital.</p>
                    </div>
                    <div className="step-card ani ani-2">
                        <div className="step-number">3</div>
                        <h3>Relaxe e cresça</h3>
                        <p>O agente posta, responde e engaja 24/7. Acompanhe tudo pelo Telegram.</p>
                    </div>
                </div>
            </section>

            {/* Pricing */}
            <section className="section section-alt" id="pricing">
                <div className="container">
                    <div className="section-header">
                        <h2>Planos <span className="gradient-text">simples</span></h2>
                        <p>Comece grátis. Sem surpresas. Cancele quando quiser.</p>
                    </div>

                    <div className="pricing-grid">
                        <div className="pricing-card ani">
                            <div className="pricing-name">Starter</div>
                            <div className="pricing-desc">Para começar a crescer</div>
                            <div className="pricing-price">
                                <span className="pricing-amount">$49</span>
                                <span className="pricing-period">/mês</span>
                            </div>
                            <div className="pricing-trial">✓ 30 dias grátis</div>
                            <ul className="pricing-features">
                                <li><span className="check-icon">✓</span> 1 conta Twitter</li>
                                <li><span className="check-icon">✓</span> Posts automáticos diários</li>
                                <li><span className="check-icon">✓</span> Respostas a menções</li>
                                <li><span className="check-icon">✓</span> Detector de trends</li>
                                <li><span className="check-icon">✓</span> Personalidade customizável</li>
                            </ul>
                            <Link href="#" className="btn btn-outline">Começar grátis</Link>
                        </div>

                        <div className="pricing-card featured ani ani-1">
                            <div className="pricing-badge">Mais popular</div>
                            <div className="pricing-name">Pro</div>
                            <div className="pricing-desc">Máximo crescimento</div>
                            <div className="pricing-price">
                                <span className="pricing-amount">$99</span>
                                <span className="pricing-period">/mês</span>
                            </div>
                            <div className="pricing-trial">✓ 30 dias grátis</div>
                            <ul className="pricing-features">
                                <li><span className="check-icon">✓</span> Twitter + Reddit</li>
                                <li><span className="check-icon">✓</span> Tudo do Starter</li>
                                <li><span className="check-icon">✓</span> Analytics avançado</li>
                                <li><span className="check-icon">✓</span> Suporte prioritário</li>
                                <li><span className="check-icon">✓</span> Estratégia de crescimento</li>
                                <li><span className="check-icon">✓</span> Dashboard dedicado</li>
                            </ul>
                            <Link href="#" className="btn btn-primary">Começar grátis</Link>
                        </div>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="cta-section container">
                <h2>Pronta para <span className="gradient-text">escalar</span>?</h2>
                <p>
                    Junte-se às criadoras que já usam IA para crescer no Twitter.
                </p>
                <p className="cta-trial">30 dias grátis · Sem cartão · Cancele quando quiser</p>
                <Link href="#pricing" className="btn btn-primary btn-lg">
                    Começar meu teste grátis
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                </Link>
            </section>

            {/* Footer */}
            <footer className="footer">
                <div className="container footer-inner">
                    <span className="footer-copy">© 2026 VelvetScale</span>
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
