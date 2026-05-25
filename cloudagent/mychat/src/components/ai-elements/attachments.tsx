import * as React from 'react';
import { FileText, ImageIcon, Music, Video, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface AttachmentData {
  id?: string;
  name?: string;
  filename?: string;
  mediaType?: string;
  type?: string;
  size?: number;
  url?: string;
  data?: string;
}

type AttachmentContextValue = {
  data: AttachmentData;
  onRemove?: () => void;
};

const AttachmentContext = React.createContext<AttachmentContextValue | null>(null);

export function Attachments({
  className,
  variant = 'grid',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: 'grid' | 'inline' | 'list' }) {
  return (
    <div
      className={cn(
        'flex gap-2',
        variant === 'grid' && 'flex-wrap',
        variant === 'inline' && 'flex-wrap items-center',
        variant === 'list' && 'flex-col',
        className,
      )}
      {...props}
    />
  );
}

export function Attachment({
  data,
  onRemove,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  data: AttachmentData;
  onRemove?: () => void;
}) {
  return (
    <AttachmentContext.Provider value={{ data, onRemove }}>
      <div
        className={cn(
          'group relative flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-panel px-2 py-2 text-sm shadow-sm',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </AttachmentContext.Provider>
  );
}

export function AttachmentPreview({ className }: { className?: string }) {
  const ctx = useAttachmentContext();
  const category = getMediaCategory(ctx.data);
  const src = ctx.data.url ?? ctx.data.data;
  if (category === 'image' && src) {
    return <img src={src} alt="" className={cn('h-10 w-10 rounded-md object-cover', className)} />;
  }
  const Icon = category === 'video' ? Video : category === 'audio' ? Music : category === 'image' ? ImageIcon : FileText;
  return (
    <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-selected text-muted', className)}>
      <Icon className="h-5 w-5" />
    </div>
  );
}

export function AttachmentInfo({ className }: { className?: string }) {
  const ctx = useAttachmentContext();
  return (
    <div className={cn('min-w-0 flex-1', className)}>
      <div className="truncate text-sm font-medium text-foreground">{getAttachmentLabel(ctx.data)}</div>
      <div className="truncate text-xs text-muted">{formatAttachmentMeta(ctx.data)}</div>
    </div>
  );
}

export function AttachmentRemove({ className }: { className?: string }) {
  const ctx = useAttachmentContext();
  if (!ctx.onRemove) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label="Remove attachment"
      onClick={ctx.onRemove}
      className={cn('ml-auto rounded-full p-1 text-muted hover:bg-selected hover:text-foreground', className)}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

export function AttachmentEmpty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted', className)} {...props}>
      No attachments
    </div>
  );
}

function getMediaCategory(data: AttachmentData): 'image' | 'video' | 'audio' | 'document' | 'source' | 'unknown' {
  const type = data.mediaType ?? data.type ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/') || type.includes('json') || type.includes('pdf')) return 'document';
  return 'unknown';
}

function getAttachmentLabel(data: AttachmentData) {
  return data.filename ?? data.name ?? (getMediaCategory(data) === 'image' ? 'Image' : 'Attachment');
}

function formatAttachmentMeta(data: AttachmentData) {
  const type = data.mediaType ?? data.type ?? 'file';
  if (!data.size) return type;
  const size = data.size < 1024 * 1024 ? `${Math.ceil(data.size / 1024)} KB` : `${(data.size / 1024 / 1024).toFixed(1)} MB`;
  return `${type} · ${size}`;
}

function useAttachmentContext() {
  const ctx = React.useContext(AttachmentContext);
  if (!ctx) {
    throw new Error('Attachment subcomponents must be used within <Attachment>');
  }
  return ctx;
}
