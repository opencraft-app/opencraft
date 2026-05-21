import * as React from 'react';
import { cn } from '../../lib/utils';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ghost' | 'soft';
  size?: 'sm' | 'md' | 'icon';
};

export function Button({ className, variant = 'default', size = 'md', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-60',
        variant === 'default' && 'bg-accent text-white hover:bg-accent/90',
        variant === 'ghost' && 'text-foreground hover:bg-selected',
        variant === 'soft' && 'bg-panel text-foreground border border-border hover:bg-selected',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'icon' && 'h-9 w-9',
        className,
      )}
      {...props}
    />
  );
}
