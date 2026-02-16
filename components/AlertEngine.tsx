
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { API_BASE_URL } from '../constants';
import { Zap, Clock, ShieldCheck, Server } from 'lucide-react';
import { motion as m, AnimatePresence } from 'framer-motion';

const motion = m as any;

const COOLDOWN_MS = 10 * 60 * 1000; // 10 Minutes
const POLL_INTERVAL_MS = 30000; // 30 Seconds

const AlertEngine: React.FC = () => {
    const { 
        market, 
        biasMatrix, 
        liquidity, 
        regime, 
        aiTactical, 
        config: { activeSymbol, isBacktest, telegramBotToken, telegramChatId },
        addNotification,
        logAlert 
    } = useStore();

    const lastAlertTimeRef = useRef<number>(0);
    const [status, setStatus] = useState<'IDLE' | 'CHECKING' | 'COOLDOWN' | 'FIRING' | 'AUTONOMOUS'>('IDLE');
    const [lastResult, setLastResult] = useState<string>("");
    const [backendAutonomous, setBackendAutonomous] = useState(false);

    // 1. Check Backend Status on Mount
    useEffect(() => {
        const checkBackend = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/alerts/status`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.autonomous_mode) {
                        setBackendAutonomous(true);
                        setStatus('AUTONOMOUS');
                        console.log("🚀 Backend Autonomous Mode Active - Frontend Loop Disabled");
                    }
                }
            } catch (e) {
                console.warn("Backend status check failed, using frontend fallback");
            }
        };
        checkBackend();
        const interval = setInterval(checkBackend, 60000); // Re-check every minute
        return () => clearInterval(interval);
    }, []);

    // 2. Main Loop (Only runs if NOT autonomous)
    useEffect(() => {
        if (backendAutonomous || isBacktest || market.metrics.price === 0) {
            return;
        }

        const checkConditions = async () => {
            const now = Date.now();
            
            if (now - lastAlertTimeRef.current < COOLDOWN_MS) {
                setStatus('COOLDOWN');
                return;
            }

            setStatus('CHECKING');

            try {
                const snapshot = {
                    symbol: activeSymbol,
                    price: market.metrics.price,
                    zScore: market.metrics.zScore,
                    skewness: market.metrics.skewness || 0,
                    bayesianPosterior: market.metrics.bayesianPosterior || 0.5,
                    expectedValueRR: market.expectedValue?.rrRatio || 0,
                    
                    tacticalProbability: aiTactical.probability,
                    biasAlignment: aiTactical.confidenceFactors.biasAlignment,
                    liquidityAgreement: aiTactical.confidenceFactors.liquidityAgreement,
                    regimeAgreement: aiTactical.confidenceFactors.regimeAgreement,
                    aiScore: aiTactical.confidenceFactors.aiScore,
                    
                    sweeps: liquidity.sweeps,
                    bosDirection: liquidity.bos.length > 0 ? liquidity.bos[0].direction : null,
                    
                    regimeType: regime.regimeType,
                    trendDirection: regime.trendDirection,
                    volatilityPercentile: regime.volatilityPercentile,
                    
                    institutionalCVD: market.metrics.institutionalCVD,
                    ofi: market.metrics.ofi,
                    toxicity: market.metrics.toxicity,
                    retailSentiment: market.metrics.retailSentiment || 50,
                    
                    dailyBias: biasMatrix.daily?.bias || 'NEUTRAL',
                    h4Bias: biasMatrix.h4?.bias || 'NEUTRAL',
                    h1Bias: biasMatrix.h1?.bias || 'NEUTRAL'
                };

                const res = await fetch(`${API_BASE_URL}/alerts/evaluate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(snapshot)
                });

                if (!res.ok) throw new Error('Evaluation Failed');
                
                const decision = await res.json();
                
                if (decision.shouldAlert && decision.aiAnalysis) {
                    setStatus('FIRING');
                    
                    const payload = {
                        symbol: activeSymbol,
                        direction: decision.aiAnalysis.direction,
                        confidence: decision.aiAnalysis.confidence,
                        entry: decision.aiAnalysis.entry,
                        stop: decision.aiAnalysis.stop,
                        target: decision.aiAnalysis.target,
                        rrRatio: (Math.abs(decision.aiAnalysis.target - decision.aiAnalysis.entry) / Math.abs(decision.aiAnalysis.entry - decision.aiAnalysis.stop)) || 0,
                        reasoning: decision.aiAnalysis.reasoning,
                        conditions: decision.passedConditions,
                        botToken: telegramBotToken,
                        chatId: telegramChatId
                    };

                    const sendRes = await fetch(`${API_BASE_URL}/alerts/send-telegram`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (sendRes.ok) {
                        addNotification({
                            id: Date.now().toString(),
                            type: 'success',
                            title: 'ALERT SENT',
                            message: `Frontend: AI confirmed ${payload.direction} setup on ${activeSymbol}.`
                        });
                        
                        await logAlert({
                            timestamp: Date.now(),
                            symbol: activeSymbol,
                            direction: payload.direction,
                            confidence: payload.confidence,
                            price: payload.entry,
                            result: "SENT (FE)"
                        });

                        lastAlertTimeRef.current = Date.now();
                        setStatus('COOLDOWN');
                    }
                } else {
                    setStatus('IDLE');
                    setLastResult(`Last Check: ${decision.score}/5 (${new Date().toLocaleTimeString()})`);
                }

            } catch (e) {
                console.error("Alert Engine Error:", e);
                setStatus('IDLE');
            }
        };

        const intervalId = setInterval(checkConditions, POLL_INTERVAL_MS);
        return () => clearInterval(intervalId);
    }, [activeSymbol, isBacktest, market.metrics, biasMatrix, liquidity, regime, aiTactical, telegramBotToken, telegramChatId, backendAutonomous]);

    if (isBacktest) return null;

    return (
        <div className="fixed bottom-6 right-6 z-40 hidden md:flex flex-col items-end gap-2 pointer-events-none">
            {lastResult && status === 'IDLE' && (
                <div className="text-[9px] text-zinc-600 font-mono bg-black/40 px-2 py-1 rounded">{lastResult}</div>
            )}
            
            <AnimatePresence>
                <motion.div 
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`
                        flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur-md shadow-lg pointer-events-auto
                        ${status === 'FIRING' ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 
                          status === 'COOLDOWN' ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' :
                          status === 'AUTONOMOUS' ? 'bg-purple-500/10 border-purple-500/30 text-purple-400' :
                          status === 'CHECKING' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' :
                          'bg-zinc-900/80 border-white/10 text-zinc-400'}
                    `}
                >
                    <div className="relative">
                        {status === 'FIRING' ? <Zap size={12} fill="currentColor" /> :
                         status === 'COOLDOWN' ? <Clock size={12} /> :
                         status === 'AUTONOMOUS' ? <Server size={12} /> :
                         <ShieldCheck size={12} />}
                        
                        {status === 'CHECKING' && (
                            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-blue-500 rounded-full animate-ping opacity-75"></span>
                        )}
                        {status === 'AUTONOMOUS' && (
                            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-purple-500 rounded-full animate-pulse opacity-75"></span>
                        )}
                    </div>
                    
                    <span className="text-[10px] font-bold uppercase tracking-wider">
                        {status === 'FIRING' ? 'BROADCASTING' : 
                         status === 'COOLDOWN' ? 'COOLDOWN' : 
                         status === 'AUTONOMOUS' ? 'BACKEND ACTIVE' :
                         status === 'CHECKING' ? 'ANALYZING' : 
                         'SENTINEL ACTIVE'}
                    </span>
                </motion.div>
            </AnimatePresence>
        </div>
    );
};

export default AlertEngine;
