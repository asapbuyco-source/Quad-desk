import { useState, useCallback } from 'react';

export type DrawingTool =
  | 'select' | 'line' | 'ray' | 'hline' | 'vline'
  | 'rect'   | 'fib'  | 'text' | 'channel' | 'arrow';

export interface DrawingPoint {
  time:  number; // ECharts x-axis value (ms timestamp)
  price: number;
}

export interface Drawing {
  id:     string;
  type:   DrawingTool;
  points: DrawingPoint[];
  style: {
    color:        string;
    lineWidth:    number;
    opacity:      number;
    dash?:        number[];
    fillOpacity?: number;
  };
  label?:    string;
  locked?:   boolean;
}

/** Preset colour palette — matches the app's design tokens */
export const DRAWING_COLORS = [
  '#3b82f6', // blue  (brand accent)
  '#10b981', // emerald (bid)
  '#f43f5e', // rose   (ask)
  '#f59e0b', // amber  (warn)
  '#a855f7', // purple
  '#e4e4e7', // white
  '#71717a', // zinc-500
] as const;

/** Fibonacci levels */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0] as const;

export const FIB_COLOR: Record<number, string> = {
  0:     '#f43f5e',
  0.236: '#f59e0b',
  0.382: '#a855f7',
  0.5:   '#e4e4e7',
  0.618: '#a855f7',
  0.786: '#f59e0b',
  1.0:   '#10b981',
};

/** Tools that only need ONE click to place */
const SINGLE_POINT_TOOLS: Set<DrawingTool> = new Set(['hline', 'vline', 'text']);

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseChartDrawingsReturn {
  drawings:     Drawing[];
  activeTool:   DrawingTool;
  setActiveTool: (t: DrawingTool) => void;
  selectedId:   string | null;
  setSelectedId: (id: string | null) => void;
  activeColor:  string;
  setActiveColor: (c: string) => void;
  inProgress:   Drawing | null;
  /** Call on first click when no drawing is in progress */
  startDrawing: (pt: DrawingPoint) => void;
  /** Call on mouse-move while a drawing is in progress */
  previewDrawing: (pt: DrawingPoint) => void;
  /** Call on second click to finalise */
  completeDrawing: (pt: DrawingPoint) => void;
  /** Discard the current in-progress shape */
  cancelDrawing: () => void;
  deleteSelected: () => void;
  clearAll: () => void;
  isDrawing: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChartDrawings(): UseChartDrawingsReturn {
  const [drawings,    setDrawings]    = useState<Drawing[]>([]);
  const [activeTool,  _setActiveTool] = useState<DrawingTool>('select');
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [activeColor, setActiveColor] = useState<string>(DRAWING_COLORS[0]);
  const [inProgress,  setInProgress]  = useState<Drawing | null>(null);

  const isDrawing = inProgress !== null;

  const setActiveTool = useCallback((t: DrawingTool) => {
    _setActiveTool(t);
    setInProgress(null);
    if (t !== 'select') setSelectedId(null);
  }, []);

  const makeStyle = (color: string, tool: DrawingTool): Drawing['style'] => ({
    color,
    lineWidth:    tool === 'fib' ? 1 : 1.5,
    opacity:      1,
    fillOpacity:  (tool === 'rect' || tool === 'fib' || tool === 'channel') ? 0.06 : 0,
  });

  const startDrawing = useCallback((pt: DrawingPoint) => {
    if (activeTool === 'select') return;

    // Single-point tools complete immediately on click
    if (SINGLE_POINT_TOOLS.has(activeTool)) {
      const d: Drawing = {
        id: `d-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type:   activeTool,
        points: [pt],
        style:  makeStyle(activeColor, activeTool),
        label:  activeTool === 'text' ? 'Label' : undefined,
      };
      setDrawings(prev => [...prev, d]);
      return;
    }

    setInProgress({
      id:     `d-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type:   activeTool,
      points: [pt],
      style:  makeStyle(activeColor, activeTool),
    });
  }, [activeTool, activeColor]);

  const previewDrawing = useCallback((pt: DrawingPoint) => {
    if (!inProgress) return;
    setInProgress(prev => {
      if (!prev) return prev;
      const points: DrawingPoint[] = [prev.points[0], pt];
      return { ...prev, points };
    });
  }, [inProgress]);

  const completeDrawing = useCallback((pt: DrawingPoint) => {
    if (!inProgress) return;
    const finalDrawing: Drawing = {
      ...inProgress,
      points: [inProgress.points[0], pt],
    };
    // Reject zero-size drawings
    const dx = finalDrawing.points[1].time  - finalDrawing.points[0].time;
    const dy = finalDrawing.points[1].price - finalDrawing.points[0].price;
    if (Math.abs(dx) < 1000 && Math.abs(dy) < 0.001) {
      setInProgress(null);
      return;
    }
    setDrawings(prev => [...prev, finalDrawing]);
    setInProgress(null);
  }, [inProgress]);

  const cancelDrawing = useCallback(() => setInProgress(null), []);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setDrawings(prev => prev.filter(d => d.id !== selectedId));
    setSelectedId(null);
  }, [selectedId]);

  const clearAll = useCallback(() => {
    setDrawings([]);
    setSelectedId(null);
    setInProgress(null);
  }, []);

  return {
    drawings, activeTool, setActiveTool,
    selectedId, setSelectedId,
    activeColor, setActiveColor,
    inProgress, startDrawing, previewDrawing, completeDrawing,
    cancelDrawing, deleteSelected, clearAll,
    isDrawing,
  };
}

