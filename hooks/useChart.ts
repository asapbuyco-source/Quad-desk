import React, { useLayoutEffect, useRef, useState, useMemo } from 'react';
import { createChart, IChartApi, ChartOptions, DeepPartial, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';
import { CandleData } from '../types';

// --- Lightweight Charts Hook ---

/**
 * Custom hook to initialize and manage a Lightweight Chart instance.
 * Handles resizing (with debounce) and cleanup to prevent memory leaks.
 * 
 * @param containerRef - React Ref to the DOM element container for the chart
 * @param options - DeepPartial<ChartOptions> for configuration (colors, layout, grid)
 * @returns IChartApi instance or null if not yet initialized
 */
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

        // Track disposal state to prevent race conditions
        let isDisposed = false;
        let resizeTimeout: ReturnType<typeof setTimeout>;

        // Initialize Chart
        const { clientWidth, clientHeight } = containerRef.current;

        const chart = createChart(containerRef.current, {
            width: clientWidth || 300,
            height: clientHeight || 300,
            ...defaultOptions,
            ...optionsRef.current,
        });

        setChartInstance(chart);

        // Handle Resizing with Debounce
        // Fix for iOS Safari race condition between ResizeObserver and Render cycle
        const handleResize = () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);

            // 75ms debounce to allow layout to settle
            resizeTimeout = setTimeout(() => {
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
            }, 75);
        };

        const resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(containerRef.current);

        return () => {
            isDisposed = true;
            resizeObserver.disconnect();
            if (resizeTimeout) clearTimeout(resizeTimeout);
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

/**
 * Calculates Volume Profile (Price-by-Volume) data from candles.
 * Distributes volume into price buckets to identify high-interest levels (POC, HVN).
 * 
 * Optimized for performance using single-pass loops and minimal array allocations.
 * 
 * @param data - CandleData array
 * @param steps - Number of vertical buckets (resolution)
 * @returns Array of VolumeBucket
 */
export const useVolumeProfileData = (data: CandleData[], steps: number = 40) => {
    return useMemo(() => {
        if (!data || data.length === 0) return [];

        let minPrice = Infinity;
        let maxPrice = -Infinity;

        // Single pass for min/max to avoid spread/map overhead
        for (let i = 0; i < data.length; i++) {
            const candle = data[i];
            if (candle.low < minPrice) minPrice = candle.low;
            if (candle.high > maxPrice) maxPrice = candle.high;
        }

        if (minPrice === Infinity || maxPrice === -Infinity || minPrice === maxPrice) return [];

        const range = maxPrice - minPrice;
        const stepSize = range / steps;

        // Typed array for efficient volume accumulation
        const volumeAccumulator = new Float64Array(steps);

        // Distribute volume proportionally across all price buckets the bar's H-L range touches.
        // This is the standard Market Profile approach — avoids concentrating entire bar volume
        // at a single close-price bucket, which mis-identifies POC on wide-range bars.
        for (let i = 0; i < data.length; i++) {
            const candle = data[i];
            if (!candle.volume) continue;

            const lowIdx = Math.max(0, Math.floor((candle.low - minPrice) / stepSize));
            const highIdx = Math.min(steps - 1, Math.floor((candle.high - minPrice) / stepSize));
            const numBuckets = highIdx - lowIdx + 1;
            const volPerBucket = candle.volume / numBuckets;
            for (let b = lowIdx; b <= highIdx; b++) {
                volumeAccumulator[b] += volPerBucket;
            }
        }

        // Find stats (max and average) in a single pass over buckets
        let maxVol = 0;
        let totalVol = 0;
        let activeBuckets = 0;
        for (let i = 0; i < steps; i++) {
            const v = volumeAccumulator[i];
            if (v > maxVol) maxVol = v;
            if (v > 0) {
                totalVol += v;
                activeBuckets++;
            }
        }

        const avgVol = activeBuckets > 0 ? totalVol / activeBuckets : 0;

        // Construct final results, reversing on the fly for display (High price top)
        const result: VolumeBucket[] = new Array(steps);
        for (let i = 0; i < steps; i++) {
            const vol = volumeAccumulator[i];
            const price = minPrice + (i * stepSize);
            const endPrice = minPrice + ((i + 1) * stepSize);

            let type = 'Normal';
            if (vol === maxVol && maxVol > 0) type = 'POC';
            else if (vol > maxVol * 0.6 && maxVol > 0) type = 'HVN';
            else if (vol < avgVol * 0.5) type = 'LVN';

            result[steps - 1 - i] = {
                price,
                endPrice,
                vol,
                rangeLabel: `${price.toFixed(2)} - ${endPrice.toFixed(2)}`,
                type
            };
        }

        return result;
    }, [data, steps]);
};