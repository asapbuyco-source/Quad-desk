import { useEffect } from 'react';

/**
 * Per-view document metadata. Crawlers that execute JS (Google) see these;
 * the static defaults in index.html cover everything else.
 */
const SEO: Record<string, { title: string; description: string }> = {
  dashboard: {
    title: 'Desk — live order flow & liquidity | Quant Desk',
    description: 'Live crypto order flow, depth and liquidity in one desk. Spot and perp prints, funding context and market structure.',
  },
  charting: {
    title: 'Chart — price action & drawing tools | Quant Desk',
    description: 'Crypto price charts with order-flow overlays and drawing tools for supply and demand levels.',
  },
  funding: {
    title: 'Funding & Open Interest — cross-venue | Quant Desk',
    description: 'Funding rates and open interest across Binance, OKX and Bybit, plus Coinbase premium and OI momentum.',
  },
  macro: {
    title: 'Macro & FX — rates, inflation, dollar | Quant Desk',
    description: 'US rates, inflation, dollar index and ECB reference FX, recorded with sources and timestamps.',
  },
  intel: {
    title: 'Intel — crypto news & sentiment | Quant Desk',
    description: 'Financial news tagged by asset with sentiment scores, summarised into market context.',
  },
  'order-flow': {
    title: 'Order Flow — executed trades & price impact | Quant Desk',
    description: 'Executed trades with taker-side classification, rolling spot/perp flow, price-impact diagnostics and liquidity events.',
  },
  pricing: {
    title: 'Plans & Billing — free and Pro | Quant Desk',
    description: 'Core crypto market data free forever. Pro unlocks the execution desk, analytics and bot tooling.',
  },
  guide: {
    title: 'Guide — how to use the terminal | Quant Desk',
    description: 'How to read order flow, funding, open interest and price impact in the terminal.',
  },
  default: {
    title: 'Quant Desk — Crypto Order Flow, Liquidity & Derivatives Terminal',
    description: 'Live order flow, cross-venue funding and open interest, price-impact diagnostics and macro context. Core data free forever.',
  },
};

export function useSeo(tab: string): void {
  useEffect(() => {
    const meta = SEO[tab] || SEO.default;
    document.title = meta.title;
    let el = document.querySelector('meta[name="description"]');
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute('name', 'description');
      document.head.appendChild(el);
    }
    el.setAttribute('content', meta.description);
  }, [tab]);
}
