import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-[#09090b] flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-zinc-900 border border-red-500/20 rounded-2xl p-8 text-center shadow-[0_0_50px_rgba(220,38,38,0.1)]">
            <div className="flex justify-center mb-6">
                <div className="p-4 bg-red-500/10 rounded-full text-red-500">
                    <AlertTriangle size={48} />
                </div>
            </div>
            <h1 className="text-2xl font-bold text-white mb-2">System Malfunction</h1>
            <p className="text-zinc-400 mb-6 text-sm font-mono">
                {this.state.error?.message || "An unexpected critical error occurred."}
            </p>
            <button 
                onClick={() => window.location.reload()}
                className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold transition-colors flex items-center justify-center gap-2"
            >
                <RefreshCw size={16} /> REBOOT SYSTEM
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;