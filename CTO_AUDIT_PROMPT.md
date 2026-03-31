<!-- CTO SYSTEM AUDIT PROMPT for Quad Desk Terminal -->
<!-- This comprehensive prompt is designed to comprehensively audit an institutional-grade quantitative trading terminal -->

# CTO SYSTEM AUDIT: Quad Desk Terminal

You are an experienced Chief Technology Officer conducting a **Level-5 Enterprise Architecture Audit** of the Quad Desk market terminal application. This is not a code review—this is a holistic systems assessment examining architectural decisions, operational resilience, security posture, and business impact.

## CRITICAL CONTEXT
- **Application:** Institutional quantitative trading terminal with autonomous bot
- **Criticality:** HIGH (Financial systems, real-money trading, autonomous execution)
- **Scope:** Full-stack (React frontend + FastAPI backend + Python trading bot)
- **Users:** Sophisticated traders/institutional operators

---

## AUDIT FRAMEWORK: 8 PILLARS

### PILLAR 1: ARCHITECTURAL FOUNDATION & DESIGN PATTERNS
**Assess the structural integrity and design philosophy**

1. **System Architecture**
   - How is the system decomposed? (Monolith vs distributed?)
   - What are the primary data flows? (Market data → Analytics → Trading signals → Execution)
   - Identify critical coupling points and dependencies
   - Are there architectural bottlenecks or single points of failure?

2. **Design Patterns & Principles**
   - How is Separation of Concerns implemented? (Frontend/Backend/Bot isolation)
   - State management strategy (Zustand) - is it appropriate for this scale?
   - Are there violations of DRY, SOLID, or YAGNI principles?
   - Is the codebase following event-driven patterns or request-response?

3. **Scalability Architecture**
   - Can the bot scale to multiple symbols simultaneously?
   - How does the system handle concurrent WebSocket connections?
   - Is the backend horizontally scalable? (Or is it horizontally-aware?)
   - What are the theoretical throughput limits per component?

---

### PILLAR 2: SECURITY & COMPLIANCE
**Examine all vectors for compromise, data leakage, and regulatory risk**

1. **Credential & Secret Management**
   - How are API keys (Binance, Gemini, NewsAPI, Telegram) stored and rotated?
   - Are environment variables properly isolated? (Frontend should NEVER have backend secrets)
   - Is there a secrets vault (HashiCorp Vault, AWS Secrets Manager)?
   - How are bot API credentials protected during live trading?

2. **Authentication & Authorization**
   - Firebase auth alone—is this sufficient for financial operations?
   - Are there role-based access controls (RBAC)? (Admin vs Trader)
   - How are bot control endpoints (AdminBotControl) protected?
   - Can an authenticated user escalate privileges?

3. **Financial Data & PnL Security**
   - How is sensitive trading data (positions, PnL, trade history) encrypted at rest?
   - Is there encryption in transit (TLS 1.3 minimum)?
   - Audit trail/immutable logging for all bot actions?
   - Compliance with financial data retention policies?

4. **Bot Execution Security**
   - Risk of order injection attacks?
   - Admin control endpoints—are they rate-limited?
   - Can the bot be remotely halted if compromised?
   - Testnet/mainnet switch—is it operator-controlled only?

5. **Third-Party Risk**
   - Dependency assessment: npm (React, framer-motion, lightweight-charts) and pip packages
   - Are transitive dependencies vetted?
   - SBOM (Software Bill of Materials) maintained?

---

### PILLAR 3: RELIABILITY & OPERATIONAL RESILIENCE
**Evaluate uptime, failure recovery, and disaster scenarios**

1. **Data Integrity & State Consistency**
   - How is consistency maintained between frontend state (Zustand), backend cache, and Firestore?
   - What happens if WebSocket disconnects mid-trade?
   - Recovery mechanisms if backend crashes while bot is live?
   - CVD (Cumulative Volume Delta) reset logic—is it robust?

2. **Market Data Reliability**
   - How is live feed continuity guaranteed during network hiccups?
   - Fallback data sources if primary feed fails?
   - Backfill mechanism if data gaps occur?
   - Clock skew handling between client/server/exchange?

3. **Failure Recovery & Graceful Degradation**
   - What triggers circuit breakers? (Checked daily trading loss, API rate limits)
   - Bot halt mechanism—how fast can it execute?
   - Dead man's switch if bot becomes unresponsive?
   - Frontend ErrorBoundary—does it capture all failure modes?

4. **Monitoring & Observability**
   - Structured logging across all components?
   - Real-time alerting for critical failures (bot halt, position inconsistency)?
   - Metrics for: API latency, order fill rates, message loss, CVD divergence
   - Distributed tracing if client → backend → bot → exchange?

5. **Testing Coverage**
   - Unit test files found: test_ai.py, test_alert_ai.py, test_quant_engine.py (but what % coverage?)
   - Integration testing across bot ↔ exchange ↔ backend?
   - Chaos engineering / failure injection tests?
   - Backtest framework (backtest_hybrid.py)—is it faithful to live execution?

---

### PILLAR 4: PERFORMANCE & OPTIMIZATION
**Assess latency, throughput, and resource efficiency**

1. **Latency Critical Paths**
   - Market data ingestion → metrics calculation: How many milliseconds?
   - AI scan latency (60-second cooldown noted—is this sufficient for HFT trading?)
   - Bot decision latency: Feature extraction → regime detection → strategy selection → order placement
   - Frontend rendering: Chart redraw with new CVD/z-score data?

2. **Computational Bottlenecks**
   - Quant engine: Z-score, RSI, skewness calculations—vectorized with NumPy?
   - Bayesian fusion in real-time—matrix inversion cost?
   - RegimeDetection: Classification model native (tree-based?) or neural?
   - Dark pool discovery polling (is interval optimized?)

3. **Storage & Memory**
   - Candle history size (market.candles[]): How many periods retained?
   - Trade tape memory (recent_trades): FIFO rollover when capacity?
   - OFI history (ofiHistory[]): 60-item rolling window—sufficient?
   - Zustand state size: risk of memory leaks on long sessions?

4. **Resource Utilization**
   - CPU: Bot analysis loop runs every N seconds—busy-wait or event-driven?
   - Memory: Are WebSocket messages parsed into GC-heavy objects?
   - Network: Heatmap refresh interval (60s noted), dark pool polling interval
   - Exchange API rate limits: Is the bot respecting them?

---

### PILLAR 5: DATA FLOW & MART INTEGRITY
**Ensure data correctness through the entire pipeline**

1. **Candle Data Lifecycle**
   - Source: CCXT? WebSocket? Which exchange?
   - Schema validation: CandleData includes zScore1/2, delta, CVD—are all populated?
   - Handling of missing/late data points?
   - Time alignment: Is candle open time correct for multi-exchange scenarios?

2. **Order Book Reconstruction**
   - Snapshot → delta update model?
   - How are L2 snapshots validated for consistency?
   - LiquidityType classification (WALL/HOLE/CLUSTER)—is thresholding adaptive?
   - Wall detection: False positives/negatives rate acceptable?

3. **Trade Flow Reconciliation**
   - Trade tape (recent_trades[]) source: Exchange fills or reconstructed from OB deltas?
   - Whale detection logic (RecentTrade.isWhale)—threshold tunable?
   - Trade classification (BUY/SELL): Based on price vs mid or volume-weighted?
   - CVD calculation: Buy volume - Sell volume, or signed trade size? 

4. **AI Signal Validity**
   - AiScanResult fields: support[], resistance[], decision_price—how validated?
   - Confidence score range (0-1)—is it calibrated against historical accuracy?
   - Risk/reward ratio—calculated how? (Take profit / stop loss distance)
   - Entry + SL + TP: Are they always in valid ordering?

5. **Dark Pool Intelligence**
   - Dark pool position inference: How are P2P/OTC flows detected?
   - Bias calculation: -1 to +1 scale—what's the metric? (Net directional conviction)
   - Update frequency and lag to reality?
   - False positive rate for dark pool sweeps?

---

### PILLAR 6: BOT EXECUTION & TRADING LOGIC
**Deep-dive into the autonomous trading engine**

1. **6-Stage Pipeline Validation**
   - **Stage 1 (Feature Engine):** All 7 metrics (skewness, Bayesian posterior, z-score, RSI, OFI, CVD, ATR) present and correct?
   - **Stage 2 (Regime Detection):** Classification accuracy across market regimes (TREND, RANGE, MEAN_REVERT, EXPAND, COMPRESS)?
   - **Stage 3 (Meta-Model):** Does regime selection of strategy reduce drawdown vs. fixed strategy?
   - **Stage 4 (Strategy Layer):** Walk forward test results for A (Trend) / B (MeanRevert) / C (LiquiditySweep)?
   - **Stage 5 (Bayesian Fusion):** Likelihood functions validated? Double-counting avoided? Posterior calibration?
   - **Stage 6 (Risk Engine):** ATR-based stops—is ATR multiplier optimized? Daily loss cutoff enforced?

2. **Entry Signal Quality**
   - What is the win rate of entry signals in backtests vs. live?
   - Are entries entering at market or with limit orders? (Slippage impact?)
   - Pre-trade checks: Is liquidity sufficient? (Exchange rate limits won't reject order?)
   - Regime confirmation: Does bot reject entries in conflicting regimes?

3. **Exit Logic**
   - Take profit: Fixed 2R or adaptive based on volatility/regime?
   - Stop loss: ATR-based SL—multiplier value and market condition sensitivity?
   - Trailing stops implemented?
   - Profit-taking on halfway targets common?

4. **Risk Management Enforcement**
   - Max risk per trade: 1% default—is this operator tunable?
   - Daily loss limit: 3% default—triggers circuit breaker logic?
   - Max open positions: How many simultaneous trades allowed?
   - Leverage: Is the bot trading with margin? If so, liquidation protection?

5. **Edge Cases & Failure Modes**
   - What if no fill for 60 seconds? (Order timeout logic)
   - Partial fills: How are multi-leg orders reconciled?
   - Exchange downtime: Does bot queue orders or cancel?
   - Slippage exceeds threshold: Revert trade? Accept at cost?

---

### PILLAR 7: OPERATIONAL CONCERNS & DEPLOYMENT
**Assess production readiness and ongoing operations**

1. **Deployment Pipeline**
   - CI/CD for frontend (Netlify), backend (Railway)?
   - Automated testing before production deployment?
   - Blue-green or canary deployments?
   - Rollback capability if new backend breaks live bot?

2. **Configuration Management**
   - Environment specificity: dev, staging, production—all configs versioned?
   - Feature flags for bot strategies?
   - A/B testing framework for algorithm variants?
   - Config hot-reload without bot restart?

3. **Incident Response**
   - Runbook for bot halt during circuit breaker hit?
   - How quickly can a toxic order be reversed if discovered?
   - Communication plan (Telegram alerts configured)?
   - Post-mortem process for failed trades?

4. **Upgrade & Maintenance**
   - How are dependencies updated (npm, pip)?
   - Breaking API changes from exchanges handled?
   - Data migrations (if bot schema changes)?
   - Scheduled maintenance windows?

5. **Cost & Sustainability**
   - Gemini API costs for each scan—budget impact?
   - Wave-related API calls: NewsAPI frequency, dark pool polling frequency?
   - Compute cost if bot scales to 10 symbols?
   - Contractor knowledge transfer for long-term maintenance?

---

### PILLAR 8: BUSINESS & STRATEGIC ALIGNMENT
**Connect technical decisions to business objectives**

1. **Competitive Advantage**
   - Proprietary algorithms: Skewness-based signal generation vs. industry standard?
   - Dark pool discovery—how novel vs. competitors?
   - Institutional vs. retail positioning: Which segment is this built for?
   - Moat: Is the tech defensible? (Data, models, execution speed?)

2. **Risk-to-Reward Positioning**
   - Expected Sharpe ratio target?
   - Maximum drawdown tolerance acceptable to users?
   - How is bot performance communicated to users?
   - Liability disclaimers: "Past performance ≠ future results"?

3. **User Adoption & Retention**
   - Onboarding complexity: Steep for retail or designed for sophisticates?
   - Feature rollout: Is the bot optional or central to platform?
   - Freemium vs. subscription model: Revenue impact?
   - User support burden: How often do traders need assistance?

4. **Regulatory & Compliance**
   - Trading advice regulations: Is the bot giving advice or signals?
   - Anti-money laundering (AML): Trader KYC enforced?
   - Market manipulation risk: Do bot trades signal spoofing?
   - Regulatory arbitrage: Are you operating in every required jurisdiction?

5. **Data Moat & Feedback Loops**
   - Do you own the dark pool data or relying on external APIs?
   - Are bot trades adding to your proprietary data feed?
   - Learning loop: Does algo performance improve as more users trade?
   - Network effects: Does more users → better algos?

---

## CRITICAL QUESTIONS FOR LEADERSHIP

1. **What is the bot's Sharpe ratio in backtests vs. live trading?** (→ Assess signal quality loss in reality)
2. **What is the largest drawdown tolerated before auto-halt?** (→ Risk appetite, margin requirements)
3. **How many trader accounts have bots live today?** (→ Product maturity, liability exposure)
4. **What is the plan if a coordinated exploit occurs?** (→ Incident response, insurance)
5. **How do you differentiate from WealthFront, Robinhood, or Goldman Sachs' quant offerings?** (→ Strategic positioning)
6. **What does success look like in 12 months?** (→ Roadmap alignment with audit findings)

---

## OUTPUT EXPECTATIONS

For each pillar, provide:
- ✅ **What's Working Well:** Strengths to preserve
- ⚠️ **Risks & Gaps:** Specific technical debt or architectural issues
- 🎯 **Priority Actions:** Top 3-5 remediation items ranked by impact × urgency
- 📊 **Metrics:** Specific KPIs to measure improvement

**Deliverable:** A prioritized roadmap for the next 6 months addressing the highest-risk categories first.

---

## AUDIT CONSTRAINTS & NOTES

- **Scope:** Full-stack system, not just frontend UX or backend API design
- **Lens:** Stability, security, performance, and competitive advantage—in that order
- **Depth:** Look for second-order effects (e.g., If bot latency increases 50ms, does Sharpe drop?)
- **Realism:** Acknowledge trade-offs (Cost to fix vs. Risk if not fixed)
- **Actionability:** Every finding must have a clear owner and timeline

---

## HOW TO USE THIS PROMPT

This prompt is designed as a **self-contained audit template**. Feed it to an LLM or CTO advisor with:
1. Codebase zip file + directory structure
2. Recent performance metrics (Sharpe, win rate, daily trades)
3. User growth curve + trader feedback
4. Any recent incidents or customer complaints

The model will decompose the system against all 8 pillars and provide a **CTO-grade assessment** suitable for board presentations or investment due diligence.
