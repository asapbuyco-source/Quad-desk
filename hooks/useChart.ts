import React, { useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { createChart, IChartApi, ChartOptions, DeepPartial, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';
import { CandleData } from '../types';

// --- Lightweight Charts Hook ---

export const useLightweightChart = (
    containerRef: React.RefObject<HTMLElement>,
    options: DeepPartial<ChartOptions> = {}
) => {
    const chartRef = useRef<IChartApi | null>(null);

    // Default Options
    const defaultOptions: DeepPartial<ChartOptions> = {
        layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: '#71717a',
            fontFamily: 'JetBrains Mono',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: {
                width: 1,
                color: 'rgba(255, 255, 255, 0.1)',
                style: LineStyle.Dashed,
                labelBackgroundColor: '#27272a',
            },
            horzLine: {
                width: 1,
                color: 'rgba(255, 255, 255, 0.1)',
                style: LineStyle.Dashed,
                labelBackgroundColor: '#27272a',
            },
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            timeVisible: true,
            secondsVisible: false,
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: {
                top: 0.1,
                bottom: 0.2,
            },
            visible: true,
        },
    };

    useLayoutEffect(() => {
        if (!containerRef.current) return;

        // Initialize Chart
        const chart = createChart(containerRef.current, {
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
            ...defaultOptions,
            ...options,
        });

        chartRef.current = chart;

        // Handle Resizing
        const handleResize = () => {
            if (containerRef.current && chartRef.current) {
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight,
                });
            }
        };

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(containerRef.current);

        return () => {
            resizeObserver.disconnect();
            chart.remove();
            chartRef.current = null;
        };
    }, []);

    return chartRef;
};

// --- Volume Profile Logic Hook ---

export interface VolumeBucket {
    price: number;
    endPrice: number;
    vol: number;
    rangeLabel: string;
    type: string; // 'POC' | 'HVN' | 'LVN' | 'Normal'
}

export const useVolumeProfileData = (data: CandleData[], steps: number = 40) => {
    return useMemo(() => {
        if (!data.length) return [];
        
        const minPrice = Math.min(...data.map(d => d.low));
        const maxPrice = Math.max(...data.map(d => d.high));
        const range = maxPrice - minPrice;
        const stepSize = range / steps;
    
        // Initialize buckets
        const buckets = Array.from({ length: steps }, (_, i) => ({
          price: minPrice + (i * stepSize),
          endPrice: minPrice + ((i + 1) * stepSize),
          vol: 0,
          rangeLabel: `${(minPrice + (i * stepSize)).toFixed(2)} - ${(minPrice + ((i + 1) * stepSize)).toFixed(2)}`,
          type: 'Normal'
        }));
    
        // Distribute volume (using close price approximation for performance)
        data.forEach(candle => {
          const index = Math.min(steps - 1, Math.floor((candle.close - minPrice) / stepSize));
          if (index >= 0) buckets[index].vol += candle.volume;
        });
    
        // Calculate Stats
        const maxVol = Math.max(...buckets.map(b => b.vol));
        const volumes = buckets.map(b => b.vol).filter(v => v > 0);
        const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    
        // Assign Types
        return buckets.map(b => {
          let type = 'Normal';
          if (b.vol === maxVol) type = 'POC'; // Point of Control
          else if (b.vol > maxVol * 0.6) type = 'HVN'; // High Volume Node
          else if (b.vol < avgVol * 0.5) type = 'LVN'; // Liquidity Hole
          
          return { ...b, type };
        }).reverse(); // Reverse to have high prices at top standard display
      }, [data, steps]);
};