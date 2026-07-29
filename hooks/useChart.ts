import { useEffect, useRef, useState, useMemo } from 'react';
import { CandleData } from '../types';

// @ts-ignore - esm.sh URL import
import * as echarts from 'https://esm.sh/echarts@5.6.0';

export const useLightweightChart = (
    containerRef: React.RefObject<HTMLElement>,
    _options: any = {}
) => {
    const chartRef = useRef<any>(null);
    const [chart, setChart] = useState<any>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const instance = echarts.init(containerRef.current, undefined, {
            renderer: 'canvas',
            devicePixelRatio: window.devicePixelRatio || 1,
        });

        chartRef.current = instance;
        setChart(instance);

        const ro = new ResizeObserver(() => {
            instance.resize();
        });
        ro.observe(containerRef.current);

        return () => {
            ro.disconnect();
            instance.dispose();
            chartRef.current = null;
            setChart(null);
        };
    }, []);

    return chart;
};

export interface VolumeBucket {
    price: number;
    endPrice: number;
    vol: number;
    rangeLabel: string;
    type: string;
}

export const useVolumeProfileData = (data: CandleData[], steps: number = 40) => {
    return useMemo(() => {
        if (!data || data.length === 0) return [];

        let minPrice = Infinity;
        let maxPrice = -Infinity;

        for (let i = 0; i < data.length; i++) {
            const candle = data[i];
            if (candle.low < minPrice) minPrice = candle.low;
            if (candle.high > maxPrice) maxPrice = candle.high;
        }

        if (minPrice === Infinity || maxPrice === -Infinity || minPrice === maxPrice) return [];

        const range = maxPrice - minPrice;
        const stepSize = range / steps;
        const volumeAccumulator = new Float64Array(steps);

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
