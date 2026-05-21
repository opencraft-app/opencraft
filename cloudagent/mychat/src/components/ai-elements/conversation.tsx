import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { Button, type ButtonProps } from '../ui/button';
import { cn } from '../../lib/utils';

interface ConversationContextValue {
  isAtBottom: boolean;
  registerContent(element: HTMLDivElement | null): void;
  shouldStickToBottom(): boolean;
  scrollToBottom(): void;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

function useConversationContext() {
  const context = useContext(ConversationContext);
  if (!context) {
    throw new Error('Conversation components must be used within Conversation');
  }
  return context;
}

export type ConversationProps = ComponentProps<'div'> & {
  children?: ReactNode;
};

export function Conversation({ className, children, ...props }: ConversationProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const updateIsAtBottom = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nextIsAtBottom = distance <= 24;
    atBottomRef.current = nextIsAtBottom;
    setIsAtBottom(nextIsAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  const registerContent = useCallback((element: HTMLDivElement | null) => {
    contentRef.current = element;
    if (element) {
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
        updateIsAtBottom();
      });
    }
  }, [updateIsAtBottom]);

  const shouldStickToBottom = useCallback(() => atBottomRef.current, []);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return undefined;

    element.addEventListener('scroll', updateIsAtBottom, { passive: true });
    const resizeObserver = new ResizeObserver(() => {
      if (atBottomRef.current) {
        element.scrollTop = element.scrollHeight;
      }
      updateIsAtBottom();
    });
    resizeObserver.observe(element);
    const mutationObserver = new MutationObserver(() => {
      if (atBottomRef.current) {
        element.scrollTop = element.scrollHeight;
      }
      updateIsAtBottom();
    });
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });

    return () => {
      element.removeEventListener('scroll', updateIsAtBottom);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [updateIsAtBottom]);

  return (
    <ConversationContext.Provider value={{ isAtBottom, registerContent, shouldStickToBottom, scrollToBottom }}>
      <div className={cn('relative flex min-h-0 flex-1 flex-col overflow-hidden', className)} role="log" {...props}>
        {children}
      </div>
    </ConversationContext.Provider>
  );
}

export type ConversationContentProps = ComponentProps<'div'> & {
  children?: ReactNode;
};

export function ConversationContent({ className, children, ...props }: ConversationContentProps) {
  const { registerContent, shouldStickToBottom } = useConversationContext();
  const localRef = useRef<HTMLDivElement | null>(null);

  const setContentRef = useCallback((element: HTMLDivElement | null) => {
    localRef.current = element;
    registerContent(element);
  }, [registerContent]);

  useLayoutEffect(() => {
    const element = localRef.current;
    if (!element || !shouldStickToBottom()) return;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [children, shouldStickToBottom]);

  return (
    <div
      ref={setContentRef}
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export function ConversationEmptyState({
  className,
  title = 'No messages yet',
  description = 'Start a conversation to see messages here',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div className={cn('flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center', className)} {...props}>
      {children ?? (
        <>
          {icon && <div className="text-muted">{icon}</div>}
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{title}</h3>
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
        </>
      )}
    </div>
  );
}

export type ConversationScrollButtonProps = ButtonProps;

export function ConversationScrollButton({ className, children, ...props }: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useConversationContext();

  if (isAtBottom) return null;

  return (
    <Button
      type="button"
      variant="soft"
      size="sm"
      className={cn('absolute left-1/2 -translate-x-1/2 rounded-full shadow-sm', className)}
      onClick={scrollToBottom}
      {...props}
    >
      {children ?? <ArrowDownIcon className="h-4 w-4" />}
    </Button>
  );
}
