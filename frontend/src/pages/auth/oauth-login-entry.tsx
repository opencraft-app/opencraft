import { Button } from "@/components/ui/button";

interface OAuthLoginEntryProps {
  href: string | null;
  label: string;
  description?: string;
}

export const OAuthLoginEntry = ({ href, label, description }: OAuthLoginEntryProps) => {
  if (!href) {
    return null;
  }

  return (
    <div className="space-y-4">
      <Button
        asChild
        variant="outline"
        className="h-12 w-full rounded-full border-[var(--lw-border)] bg-[var(--lw-bg-elevated)] text-[var(--lw-fg)] shadow-[var(--lw-shadow-base)] hover:border-[var(--lw-accent)] hover:bg-[var(--lw-accent-light)]"
      >
        <a href={href}>{label}</a>
      </Button>
      {description ? <p className="text-sm leading-7 text-[var(--text-secondary)]">{description}</p> : null}
    </div>
  );
};
