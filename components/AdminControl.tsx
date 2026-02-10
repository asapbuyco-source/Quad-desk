import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { useStore } from '../store';

const AdminControl: React.FC = () => {
    const { auth: { user, registrationOpen }, toggleRegistration } = useStore();
    const [isOpen, setIsOpen] = React.useState(false);

    // Hardcoded Admin Check based on prompt requirements
    const isAdmin = user?.email?.toLowerCase() === 'abrackly@gmail.com';

    if (!isAdmin) return null;

    return (
        <>
            {/* Floating Admin Badge */}
            <motion.button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 left-6 z-[60] px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded-full text-rose-500 flex items-center gap-2 backdrop-blur-md hover:bg-rose-500/20 transition-colors group"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
            >
                <ShieldAlert size={16} />
                <span className="text-[10px] font-bold uppercase tracking-wider hidden group-hover:inline-block">Admin Control</span>
            </motion.button>

            {/* Admin Modal */}
            <AnimatePresence>
                {isOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsOpen(false)}
                            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        />
                        <motion.div 
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="relative z-10 w-full max-w-sm bg-[#18181b] border border-rose-500/30 rounded-2xl shadow-[0_0_30px_rgba(244,63,94,0.1)] overflow-hidden"
                        >
                            <div className="p-4 border-b border-white/5 flex items-center justify-between bg-rose-500/5">
                                <div className="flex items-center gap-2">
                                    <ShieldAlert size={18} className="text-rose-500" />
                                    <h3 className="text-sm font-bold text-white uppercase tracking-wide">System Administration</h3>
                                </div>
                                <button onClick={() => setIsOpen(false)} className="text-zinc-500 hover:text-white transition-colors">
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="p-6">
                                <p className="text-xs text-zinc-400 mb-6 font-mono border-l-2 border-rose-500/50 pl-3">
                                    AUTHORIZED PERSONNEL ONLY: {user.email}
                                </p>

                                <div className="flex items-center justify-between p-4 bg-black/40 rounded-xl border border-white/5">
                                    <div>
                                        <div className="text-sm font-bold text-white mb-1">New Registrations</div>
                                        <div className={`text-[10px] font-bold uppercase ${registrationOpen ? 'text-emerald-500' : 'text-rose-500'}`}>
                                            Status: {registrationOpen ? 'OPEN' : 'CLOSED'}
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => toggleRegistration(!registrationOpen)}
                                        className={`p-2 rounded-lg transition-colors ${registrationOpen ? 'text-emerald-500 hover:text-emerald-400' : 'text-rose-500 hover:text-rose-400'}`}
                                    >
                                        {registrationOpen ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
};

export default AdminControl;