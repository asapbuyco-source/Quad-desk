import React, { useEffect } from 'react';
import { useStore } from '../store';
import { apiFetch } from '../utils/apiClient';

/**
 * Polls active price alerts while the desk is open. Browser notifications are
 * used when permission has been granted; the in-app toast always fires.
 */
const PriceAlertWatcher: React.FC = () => {
  const alerts = useStore(s => s.priceAlerts);
  const trigger = useStore(s => s.triggerPriceAlert);
  const addNotification = useStore(s => s.addNotification);

  useEffect(() => {
    const active = alerts.filter(a => !a.triggeredAt);
    if (!active.length) return;
    let dead = false;

    const priceOf = async (symbol: string): Promise<number | undefined> => {
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          const px = parseFloat(j?.price);
          if (Number.isFinite(px)) return px;
        }
      } catch { /* try backend */ }
      try {
        const r = await apiFetch(`/premium?symbol=${symbol}`, { timeoutMs: 20000 });
        const j = await r.json();
        const px = Number(j?.binance ?? j?.coinbase);
        return Number.isFinite(px) ? px : undefined;
      } catch { return undefined; }
    };

    const check = async () => {
      for (const a of active) {
        if (dead) return;
        const px = await priceOf(a.symbol);
        if (px === undefined || dead) continue;
        const hit = a.direction === 'above' ? px >= a.price : px <= a.price;
        if (!hit) continue;
        trigger(a.id);
        addNotification({
          id: `alert_${a.id}`,
          type: 'warning',
          title: `${a.symbol} ${a.direction} ${a.price}`,
          message: `Price is now ${px.toLocaleString()}. Alert triggered.`,
        });
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`Quant Desk · ${a.symbol}`, { body: `Price ${a.direction} ${a.price} (now ${px})` });
          }
        } catch { /* ignore */ }
      }
    };

    check();
    const id = setInterval(check, 20000);
    return () => { dead = true; clearInterval(id); };
  }, [alerts, trigger, addNotification]);

  return null;
};

export default PriceAlertWatcher;
