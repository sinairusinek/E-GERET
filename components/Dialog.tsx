import React, { useEffect, useRef } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ open, onClose, title, children, actions }) => {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="backdrop:bg-black/50 rounded-2xl p-0 shadow-2xl max-w-md w-full border-none"
    >
      <div className="p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-4">{title}</h2>
        {children}
        {actions && <div className="flex justify-end gap-3 mt-6">{actions}</div>}
      </div>
    </dialog>
  );
};
