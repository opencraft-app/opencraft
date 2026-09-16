import { useRef } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { CuratedSkillBullet, CuratedSkillOverview } from "./curated-skill-overviews";

export interface CuratedSkillDetailsViewProps {
  open: boolean;
  name: string;
  rawId: string;
  sourceUrl?: string;
  overview: CuratedSkillOverview;
  installed: boolean;
  installing: boolean;
  labels: { close: string; source: string; what: string; overview: string; who: string; why: string; problems: string; capabilities: string; how: string; usage: string; installed: string; install: string };
  onInstall: () => void;
  onClose: () => void;
}
export function CuratedSkillDetailsView({ open, name, rawId, sourceUrl, overview, installed, installing, labels, onInstall, onClose }: CuratedSkillDetailsViewProps) {
  const trigger = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent portalClassName="agents-ui" closeLabel={labels.close}
        className="lv-curated-skill-dialog-scroll max-h-[calc(100dvh-32px)] overflow-y-auto rounded-md md:w-[min(820px,calc(100vw-32px))]"
        onOpenAutoFocus={(event) => {
          trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus(); } }}>
        <div className="pr-8">
          <DialogTitle ref={titleRef} tabIndex={-1} className="text-balance text-lg font-semibold text-black/90">{name}</DialogTitle>
          <DialogDescription className="mt-1 break-all font-mono text-xs leading-5 text-black/45">{rawId}</DialogDescription>
          {sourceUrl ? (
            <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-black/45">
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate text-[#2563EB] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {labels.source}
              </a>
            </div>
          ) : null}
        </div>

        <div className="mt-5 space-y-6 border-t border-black/[0.07] pt-5">
          <section>
            <h3 className="text-base font-semibold text-black/90">{labels.what}</h3>
            <h4 className="mt-3 text-sm font-semibold text-black/75">{labels.overview}</h4>
            <p className="mt-2 text-sm leading-6 text-black/65">{overview.overview[0]}</p>
            <p className="mt-3 text-sm leading-6 text-black/65">{overview.overview[1]}</p>
          </section>

          <SkillOverviewBullets heading={labels.who} bullets={overview.whoShouldUse} />

          <section>
            <h3 className="text-base font-semibold text-black/90">{labels.why}</h3>
            <SkillOverviewBullets heading={labels.problems} bullets={overview.problemsItSolves} nested />
            <SkillOverviewBullets heading={labels.capabilities} bullets={overview.keyCapabilities} nested />
          </section>

          <section>
            <h3 className="text-base font-semibold text-black/90">{labels.how}</h3>
            <h4 className="mt-3 text-sm font-semibold text-black/75">{labels.usage}</h4>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-black/65">{overview.basicUsage}</p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-black/[0.04] px-3 py-3 font-mono text-xs leading-5 text-black/75">
              <code>{overview.examplePrompt}</code>
            </pre>
          </section>
        </div>

        <div className="mt-5 flex justify-end">
          {installed ? (
            <span className="inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-semibold text-[#5C9A8B]">
              <Check className="size-4" aria-hidden="true" />
              {labels.installed}
            </span>
          ) : (
            <Button
              type="button"
              onClick={onInstall}
              disabled={installing}
              className="inline-flex h-10 min-w-[112px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition-colors hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {installing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
              {labels.install}
            </Button>
          )}
        </div>

      </DialogContent>
    </Dialog>
  );
}

function SkillOverviewBullets({
  heading,
  bullets,
  nested = false,
}: {
  heading: string;
  bullets: readonly CuratedSkillBullet[];
  nested?: boolean;
}) {
  return (
    <section className={nested ? "mt-5" : undefined}>
      <h3 className={nested ? "text-sm font-semibold text-black/75" : "text-base font-semibold text-black/90"}>{heading}</h3>
      <ul className="mt-3 space-y-2.5">
        {bullets.map((bullet) => (
          <li key={bullet.title} className="text-sm leading-6 text-black/65">
            <strong className="font-semibold text-black/80">{bullet.title}:</strong>{" "}
            {bullet.description}
          </li>
        ))}
      </ul>
    </section>
  );
}
