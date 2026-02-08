import React, { useLayoutEffect, useRef, useState, useMemo } from 'react';
import { createChart, IChartApi, ChartOptions, DeepPartial, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';
import { CandleData } from '../types';

// --- Lightweight Charts Hook ---

export const useLightweightChart = (
    containerRef: React.RefObject<HTMLElement>,
    options: DeepPartial<ChartOptions> = {}
) => {
    const [chartInstance, setChartInstance] = useState<IChartApi | null>(null);
    
    // Store options in ref to avoid re-triggering effect on every render if options object is new
    const optionsRef = useRef(options);
    optionsRef.current = options;

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
            rightOffset: 5,
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
            scaleMargins: {
                top: 0.1,
                bottom: 0.2,
            },
            visible: true,
        },
        // Enhanced Interactivity
        handleScale: {
            axisPressedMouseMove: true,
            mouseWheel: true,
            pinch: true,
        },
        handleScroll: {
            vertTouchDrag: false,
            pressedMouseMove: true,
            mouseWheel: true,
            horzTouchDrag: true,
        },
        kineticScroll: {
            touch: true,
            mouse: true,
        },
    };

    useLayoutEffect(() => {
        if (!containerRef.current) return;

        // Track disposal state to prevent race conditions with ResizeObserver/RAF
        let isDisposed = false;

        // Initialize Chart
        const { clientWidth, clientHeight } = containerRef.current;
        
        const chart = createChart(containerRef.current, {
            width: clientWidth || 300,
            height: clientHeight || 300,
            ...defaultOptions,
            ...optionsRef.current,
        });

        setChartInstance(chart);

        // Handle Resizing
        const handleResize = () => {
            // Use requestAnimationFrame to ensure we are resizing in sync with browser paint cycle
            // and prevent "disappearing" chart issues on mobile scroll/resize events
            window.requestAnimationFrame(() => {
                if (isDisposed) return;
                
                if (containerRef.current && chart) {
                    const width = containerRef.current.clientWidth;
                    const height = containerRef.current.clientHeight;
                    
                    // Only resize if dimensions are valid to prevent 0-height collapse
                    if (width > 0 && height > 0) {
                        try {
                            chart.applyOptions({ width, height });
                        } catch (e) {
                            // Ignore resize errors on disposed chart
                            console.warn("Chart resize failed:", e);
                        }
                    }
                }
            });
        };

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(containerRef.current);

        return () => {
            isDisposed = true;
            resizeObserver.disconnect();
            try {
                chart.remove();
            } catch (e) {
                console.warn("Chart remove failed:", e);
            }
            setChartInstance(null);
        };
    }, []);

    return chartInstance;
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
        if (!data || data.length === 0) return [];
        
        const lows = data.map(d => d.low).filter(v => typeof v === 'number' && !isNaN(v));
        const highs = data.map(d => d.high).filter(v => typeof v === 'number' && !isNaN(v));

        if (lows.length === 0 || highs.length === 0) return [];

        const minPrice = Math.min(...lows);
        const maxPrice = Math.max(...highs);
        
        if (minPrice === Infinity || maxPrice === -Infinity || minPrice === maxPrice) return [];

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
          if (!candle || typeof candle.close !== 'number' || typeof candle.volume !== 'number') return;
          const index = Math.min(steps - 1, Math.floor((candle.close - minPrice) / stepSize));
          if (index >= 0 && index < buckets.length) buckets[index].vol += candle.volume;
        });
    
        // Calculate Stats
        const maxVol = Math.max(...buckets.map(b => b.vol));
        const volumes = buckets.map(b => b.vol).filter(v => v > 0);
        const avgVol = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    
        // Assign Types
        return buckets.map(b => {
          let type = 'Normal';
          if (b.vol === maxVol && maxVol > 0) type = 'POC'; // Point of Control
          else if (b.vol > maxVol * 0.6 && maxVol > 0) type = 'HVN'; // High Volume Node
          else if (b.vol < avgVol * 0.5) type = 'LVN'; // Liquidity Hole
          
          return { ...b, type };
        }).reverse(); // Reverse to have high prices at top standard display
      }, [data, steps]);
};