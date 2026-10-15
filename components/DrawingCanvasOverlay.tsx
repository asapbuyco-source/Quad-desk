import React, { useRef, useEffect } from 'react';
import { Drawing, FIB_LEVELS, FIB_COLOR } from '../hooks/useChartDrawings';

interface DrawingCanvasOverlayProps {
  drawings: Drawing[];
  inProgress: Drawing | null;
  selectedId: string | null;
  onSelectDrawing: (id: string | null) => void;
  chart: any; // ECharts instance
}

export const DrawingCanvasOverlay: React.FC<DrawingCanvasOverlayProps> = ({
  drawings,
  inProgress,
  selectedId,
  chart,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chart) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Track size so we only resize the backing store when it actually changes.
    // Reassigning canvas.width every frame resets the transform and forces a
    // full reallocation, which flickers during pan/zoom.
    let lastW = 0;
    let lastH = 0;

    const draw = () => {
      const parent = canvas.parentElement;
      const width = parent?.clientWidth || canvas.width;
      const height = parent?.clientHeight || canvas.height;
      const dpr = window.devicePixelRatio || 1;

      if (width !== lastW || height !== lastH) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        lastW = width;
        lastH = height;
      }

      // Absolute transform (not relative scale) so repeated draws never compound.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Coordinate conversion helper using ECharts convertToPixel
      const toPx = (timeMs: number, price: number): [number, number] | null => {
        try {
          const pt = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [timeMs, price]);
          if (!pt || isNaN(pt[0]) || isNaN(pt[1])) return null;
          return [pt[0], pt[1]];
        } catch {
          return null;
        }
      };

      const renderItem = (d: Drawing, isSelected: boolean, isTemp: boolean = false) => {
        const { type, points, style, label } = d;
        if (!points || points.length === 0) return;

        const p0 = toPx(points[0].time, points[0].price);
        if (!p0) return;

        ctx.save();
        ctx.strokeStyle = style.color;
        ctx.fillStyle = style.color;
        ctx.lineWidth = isSelected ? style.lineWidth + 1.5 : style.lineWidth;
        if (style.dash) ctx.setLineDash(style.dash);
        if (isTemp) {
          ctx.globalAlpha = 0.75;
          ctx.setLineDash([4, 4]);
        }

        if (type === 'hline') {
          ctx.beginPath();
          ctx.moveTo(0, p0[1]);
          ctx.lineTo(width, p0[1]);
          ctx.stroke();

          ctx.fillStyle = style.color;
          ctx.fillRect(width - 65, p0[1] - 9, 65, 18);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(points[0].price.toFixed(2), width - 32, p0[1]);
        } else if (type === 'vline') {
          ctx.beginPath();
          ctx.moveTo(p0[0], 0);
          ctx.lineTo(p0[0], height);
          ctx.stroke();
        } else if (points.length >= 2) {
          const p1 = toPx(points[1].time, points[1].price);
          if (!p1) {
            ctx.restore();
            return;
          }

          if (type === 'line') {
            ctx.beginPath();
            ctx.moveTo(p0[0], p0[1]);
            ctx.lineTo(p1[0], p1[1]);
            ctx.stroke();

            if (isSelected) {
              [p0, p1].forEach(([x, y]) => {
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
              });
            }
          } else if (type === 'ray') {
            // Extend the ray from p0 through p1 to the canvas edge.
            const dx = p1[0] - p0[0];
            const dy = p1[1] - p0[1];
            const angle = Math.atan2(dy, dx);
            const extDist = Math.max(width, height) * 2;
            const extX = p0[0] + Math.cos(angle) * extDist;
            const extY = p0[1] + Math.sin(angle) * extDist;   // FIX: was p0[0] (x used for y)

            ctx.beginPath();
            ctx.moveTo(p0[0], p0[1]);
            ctx.lineTo(extX, extY);
            ctx.stroke();
          } else if (type === 'rect') {
            const rx = Math.min(p0[0], p1[0]);
            const ry = Math.min(p0[1], p1[1]);
            const rw = Math.abs(p1[0] - p0[0]);
            const rh = Math.abs(p1[1] - p0[1]);

            ctx.fillStyle = style.color;
            ctx.globalAlpha = style.fillOpacity || 0.12;
            ctx.fillRect(rx, ry, rw, rh);

            ctx.globalAlpha = 1;
            ctx.strokeRect(rx, ry, rw, rh);
          } else if (type === 'fib') {
            const lowPrice = Math.min(points[0].price, points[1].price);
            const highPrice = Math.max(points[0].price, points[1].price);
            const range = highPrice - lowPrice;

            FIB_LEVELS.forEach(lvl => {
              const fibPrice = points[0].price > points[1].price
                ? highPrice - range * lvl
                : lowPrice + range * lvl;
              const ptFib = toPx(points[0].time, fibPrice);
              if (!ptFib) return;

              const lvlColor = FIB_COLOR[lvl] || style.color;
              ctx.save();
              ctx.strokeStyle = lvlColor;
              ctx.lineWidth = 1;
              ctx.setLineDash(lvl === 0.5 ? [] : [3, 3]);

              const startX = Math.min(p0[0], p1[0]);
              const endX = Math.max(p0[0], p1[0]) + 80;

              ctx.beginPath();
              ctx.moveTo(startX, ptFib[1]);
              ctx.lineTo(endX, ptFib[1]);
              ctx.stroke();

              ctx.fillStyle = lvlColor;
              ctx.font = '8px "JetBrains Mono", monospace';
              ctx.textAlign = 'left';
              ctx.fillText(`${lvl} (${fibPrice.toFixed(2)})`, endX + 4, ptFib[1] + 3);
              ctx.restore();
            });
          }
        }

        if (type === 'text' && label) {
          ctx.fillStyle = style.color;
          ctx.font = 'bold 11px "JetBrains Mono", monospace';
          ctx.fillText(label, p0[0] + 5, p0[1] - 5);
        }

        ctx.restore();
      };

      drawings.forEach(d => renderItem(d, d.id === selectedId));
      if (inProgress) renderItem(inProgress, false, true);
    };

    draw();

    // Redraw on pan/zoom so drawings stay pinned to the chart coordinates.
    let raf = 0;
    const handleSync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    chart.on('dataZoom', handleSync);
    chart.on('rendered', handleSync);

    return () => {
      cancelAnimationFrame(raf);
      chart.off('dataZoom', handleSync);
      chart.off('rendered', handleSync);
    };
  }, [drawings, inProgress, selectedId, chart]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none z-20"
    />
  );
};
