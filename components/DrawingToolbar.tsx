import React from 'react';
import { 
  DrawingTool, 
  DRAWING_COLORS 
} from '../hooks/useChartDrawings';
import { 
  MousePointer, 
  TrendingUp, 
  ArrowRight, 
  Minus, 
  Columns, 
  Square, 
  Layers, 
  Type, 
  Trash2, 
  RotateCcw
} from 'lucide-react';

interface DrawingToolbarProps {
  activeTool: DrawingTool;
  onSelectTool: (tool: DrawingTool) => void;
  activeColor: string;
  onSelectColor: (color: string) => void;
  selectedId: string | null;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  drawingCount: number;
}

const TOOLS: { tool: DrawingTool; label: string; icon: React.ReactNode }[] = [
  { tool: 'select', label: 'Select / Cursor', icon: <MousePointer size={14} /> },
  { tool: 'line', label: 'Trend Line', icon: <TrendingUp size={14} /> },
  { tool: 'ray', label: 'Ray Line', icon: <ArrowRight size={14} /> },
  { tool: 'hline', label: 'Horizontal Line', icon: <Minus size={14} /> },
  { tool: 'vline', label: 'Vertical Line', icon: <Columns size={14} className="rotate-90" /> },
  { tool: 'rect', label: 'Rectangle / Zone', icon: <Square size={14} /> },
  { tool: 'fib', label: 'Fib Retracement', icon: <Layers size={14} /> },
  { tool: 'text', label: 'Text Note', icon: <Type size={14} /> },
];

export const DrawingToolbar: React.FC<DrawingToolbarProps> = ({
  activeTool,
  onSelectTool,
  activeColor,
  onSelectColor,
  selectedId,
  onDeleteSelected,
  onClearAll,
  drawingCount,
}) => {
  return (
    <div className="absolute left-3 top-16 z-30 flex flex-col gap-1 bg-[#09090b]/90 backdrop-blur-md p-1.5 rounded-xl border border-white/10 shadow-2xl transition-all">
      {/* Tool Selector Buttons */}
      <div className="flex flex-col gap-0.5">
        {TOOLS.map(({ tool, label, icon }) => {
          const isActive = activeTool === tool;
          return (
            <button
              key={tool}
              onClick={() => onSelectTool(tool)}
              title={label}
              className={`p-1.5 rounded-lg transition-all flex items-center justify-center relative group ${
                isActive 
                  ? 'bg-brand-accent text-white shadow-md shadow-brand-accent/30' 
                  : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {icon}
              {/* Tooltip on Hover */}
              <span className="absolute left-full ml-2 px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-[10px] text-zinc-300 font-medium whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                {label}
              </span>
            </button>
          );
        })}
      </div>

      <div className="h-px bg-white/10 my-1 w-full" />

      {/* Color Picker Dropdown / Bar */}
      <div className="flex flex-col items-center gap-1.5 py-0.5">
        <div className="grid grid-cols-2 gap-1">
          {DRAWING_COLORS.slice(0, 6).map((color) => (
            <button
              key={color}
              onClick={() => onSelectColor(color)}
              className={`w-3.5 h-3.5 rounded-full transition-transform ${
                activeColor === color ? 'scale-125 ring-2 ring-white/60' : 'hover:scale-110 opacity-70 hover:opacity-100'
              }`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
      </div>

      {/* Action Buttons: Delete Selected or Clear All */}
      {(selectedId || drawingCount > 0) && (
        <>
          <div className="h-px bg-white/10 my-1 w-full" />
          <div className="flex flex-col gap-1">
            {selectedId && (
              <button
                onClick={onDeleteSelected}
                title="Delete Selected"
                className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/20 transition-colors flex items-center justify-center"
              >
                <Trash2 size={13} />
              </button>
            )}
            {drawingCount > 0 && (
              <button
                onClick={onClearAll}
                title={`Clear All (${drawingCount})`}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors flex items-center justify-center"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

