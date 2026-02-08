import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  removeToast: (id: string) => void;
}

const ToastItem: React.FC<{ toast: ToastMessage; remove: (id: string) => void }> = ({ toast, remove }) => {
  useEffect(() => {
    const timer = setTimeout(() => remove(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, remove]);

  const icons = {
    success: <CheckCircle2 size={18} className="text-emerald-500" />,
    error: <AlertTriangle size={18} className="text-rose-500" />,
    warning: <AlertTriangle size={18} className="text-amber-500" />,
    info: <Info size={18} className="text-blue-500" />
  };

  const styles = {
    success: 'border-emerald-500/20 bg-[#064e3b]/90 shadow-[0_0_15px_rgba(16,185,129,0.1)]',
    error: 'border-rose-500/20 bg-[#881337]/90 shadow-[0_0_15px_rgba(244,63,94,0.1)]',
    warning: 'border-amber-500/20 bg-[#78350f]/90 shadow-[0_0_15px_rgba(245,158,11,0.1)]',
    info: 'border-blue-500/20 bg-[#1e3a8a]/90 shadow-[0_0_15px_rgba(59,130,246,0.1)]'
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 20, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
      className={`pointer-events-auto flex w-full max-w-sm rounded-xl border p-4 backdrop-blur-md ${styles[toast.type]}`}
    >
      <div className="flex-shrink-0 pt-0.5">{icons[toast.type]}</div>
      <div className="ml-3 flex-1">
        <p className="text-sm font-bold text-white">{toast.title}</p>
        <p className="mt-1 text-xs text-zinc-300 leading-relaxed">{toast.message}</p>
      </div>
      <div className="ml-4 flex flex-shrink-0">
        <button onClick={() => remove(toast.id)} className="inline-flex text-zinc-400 hover:text-white transition-colors">
          <X size={14} />
        </button>
      </div>
    </motion.div>
  );
};

export const ToastContainer: React.FC<ToastProps> = ({ toasts, removeToast }) => {
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none items-end">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} remove={removeToast} />
        ))}
      </AnimatePresence>
    </div>
  );
};