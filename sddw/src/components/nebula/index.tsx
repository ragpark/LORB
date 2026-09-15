/**
 * Nebula Design System adapters.
 *
 * These thin wrappers give features one import for design-system primitives. When the Nebula
 * React package is available in the Cookie registry, re-export its components from here (keeping
 * the same prop shapes) and delete the Tailwind implementations — features do not change.
 */
import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-gray-100 text-gray-800', brand: 'bg-brand-50 text-brand-800', success: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800', danger: 'bg-red-50 text-red-800', info: 'bg-blue-50 text-blue-800',
};

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', toneClass[tone], className)} {...rest} />;
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }>(
  ({ variant = 'secondary', size = 'md', className, ...rest }, ref) => (
    <button ref={ref} className={clsx(
      'inline-flex items-center justify-center gap-1.5 rounded-nebula font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
      variant === 'primary' && 'bg-brand-700 text-white hover:bg-brand-800',
      variant === 'secondary' && 'border border-surface-line bg-surface text-ink hover:bg-surface-alt',
      variant === 'ghost' && 'text-brand-700 hover:bg-brand-50',
      variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
      className,
    )} {...rest} />
  ));
Button.displayName = 'Button';

export function Card({ title, actions, className, children, ...rest }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('rounded-nebula border border-surface-line bg-surface shadow-sm', className)} {...rest}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-surface-line px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={clsx('h-10 w-full rounded-nebula border border-surface-line bg-surface px-3 text-sm placeholder:text-ink-subtle', className)} {...rest} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={clsx('w-full rounded-nebula border border-surface-line bg-surface px-3 py-2 text-sm placeholder:text-ink-subtle', className)} {...rest} />
));
Textarea.displayName = 'Textarea';

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx('h-10 rounded-nebula border border-surface-line bg-surface px-3 text-sm', className)} {...rest} />;
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-subtle">{hint}</span>}
    </label>
  );
}

export function Table({ headers, children, caption }: { headers: ReactNode[]; children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-alt text-xs uppercase tracking-wide text-ink-muted">
          <tr>{headers.map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-surface-line">{children}</tbody>
      </table>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; ariaLabel: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1 border-b border-surface-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-sm', value === t.id ? 'border-brand-700 font-semibold text-brand-700' : 'border-transparent text-ink-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="dlg-title" className="w-full max-w-lg rounded-nebula bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-surface-line px-4 py-3">
          <h2 id="dlg-title" className="text-base font-semibold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-alt">✕</button>
        </header>
        <div className="p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-surface-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Completion'}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-line"><div className="h-full bg-brand-700" style={{ width: `${value}%` }} /></div>
      <span className="text-xs tabular-nums text-ink-muted">{value}%</span>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-nebula border border-dashed border-surface-line p-8 text-center">
      <p className="font-medium">{title}</p>
      {body && <p className="mt-1 text-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-ink-muted"><span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-700 border-t-transparent" />{label}…</span>;
}

export function Stat({ label, value, tone = 'neutral', onClick }: { label: string; value: number | string; tone?: Tone; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={clsx('rounded-nebula border border-surface-line bg-surface p-4 text-left shadow-sm', onClick && 'hover:border-brand-300')}>
      <div className="text-xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold', tone !== 'neutral' && toneClass[tone].split(' ')[1])}>{value}</div>
    </Comp>
  );
}
