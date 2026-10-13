import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n/t";

export function AgentWeixinAccountConflictDialog({ owner, onClose, onVisit }: {
  owner: { botId: string; botName: string } | null;
  onClose: () => void;
  onVisit: (botId: string) => void;
}) {
  return (
    <Dialog open={Boolean(owner)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent closeLabel={t("关闭")} className="bg-white md:w-[30rem]">
        <DialogHeader className="pr-6">
          <DialogTitle>{t("该微信已连接其他 Bot")}</DialogTitle>
          <DialogDescription className="pt-3 leading-6">
            {t("该微信已连接「{{name}}」。", { name: owner?.botName ?? "" })}
            <br />
            {t("请先断开该 Bot 的微信，再连接当前 Bot。")}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="outline" onClick={onClose}>{t("关闭")}</Button>
          <Button onClick={() => { if (owner) onVisit(owner.botId); }}>{t("前往该 Bot")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
