import * as React from 'react';
import { cn } from '../../lib/utils';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-20 w-full resize-none rounded-[20px] border-0 bg-input px-4 py-3 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted sm:min-h-24 sm:px-5 sm:py-4',
        className,
      )}
      {...props}
    />
  ),
);

Textarea.displayName = 'Textarea';
