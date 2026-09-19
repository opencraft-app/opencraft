import { ArrowLeft, FileText } from "lucide-react";
import { useState } from "react";
import { AccountOrdersTable, type OrderItem } from "@/components/account/account-orders-table";
import { InvoiceDialog } from "@/components/account/invoice-dialog";
import { ProductPageShell } from "@/components/site/product-chrome";
import { Button } from "@/components/ui/button";
import { DisplayTitle } from "@/components/ui/display-title";
import { AppLink } from "@/lib/app-navigation";
import { isGlobal } from "@/lib/region";

const mockOrders: readonly OrderItem[] = [
  { id: "202604167832", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-04-16 21:52:02", status: "已完成" },
  { id: "202604021456", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-04-02 14:26:40", status: "已完成" },
  { id: "202603261893", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-03-26 20:47:05", status: "已完成" },
  { id: "202603262047", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-03-26 20:46:56", status: "已完成" },
  { id: "202602231100", description: "基础体验包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-02-23 19:00:14", status: "已完成" },
];

export const AccountOrdersPage = () => {
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  return (
    <ProductPageShell footer={null}>
      <main className="agents-ui relative z-10 min-w-0 flex-grow pb-16 pt-24">
        <section className="mx-auto w-full max-w-[60rem] min-w-0 px-4 sm:px-6 md:px-8">
          <AppLink to="/account" className="mb-5 inline-flex items-center gap-1 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2">
            <ArrowLeft className="size-3.5" aria-hidden="true" /> 返回账号信息
          </AppLink>
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <DisplayTitle className="text-balance">订单历史</DisplayTitle>
              <p className="mt-1.5 text-pretty text-sm text-[var(--text-secondary)]">查看和管理您的支付历史记录。</p>
            </div>
            <Button type="button" variant="outline" className="self-start" onClick={() => setInvoiceOpen(true)}>
              <FileText className="size-4" aria-hidden="true" />申请发票
            </Button>
          </div>
          <AccountOrdersTable orders={mockOrders} currencyFormatter={(amount) => isGlobal ? "$0.00" : amount} pagination={{ currentPage: 1, pageSize: 10, totalCount: mockOrders.length }} />
        </section>
      </main>
      <InvoiceDialog open={invoiceOpen} onOpenChange={setInvoiceOpen} />
    </ProductPageShell>
  );
};
