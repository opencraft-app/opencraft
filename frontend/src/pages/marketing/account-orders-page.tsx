import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, FileText, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "@/contexts/session-context";
import { BrandMark } from "@/components/site/brand-mark";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";

/* ─── Mock Order Data ─── */

interface OrderItem {
  id: string;
  description: string;
  type: string;
  duration: string;
  quantity: number;
  amount: string;
  date: string;
  status: string;
}

const mockOrders: OrderItem[] = [
  { id: "202604167832", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "$0.00", date: "2026-04-16 21:52:02", status: "已完成" },
  { id: "202604021456", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "$0.00", date: "2026-04-02 14:26:40", status: "已完成" },
  { id: "202603261893", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "$0.00", date: "2026-03-26 20:47:05", status: "已完成" },
  { id: "202603262047", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "$0.00", date: "2026-03-26 20:46:56", status: "已完成" },
  { id: "202602231100", description: "基础体验包", type: "购买", duration: "–", quantity: 1, amount: "$0.00", date: "2026-02-23 19:00:14", status: "已完成" },
];

/* ─── Navbar ─── */

const OrdersNavbar = () => {
  const { isAuthenticated: isLoggedIn } = useSession();

  return (
    <header className="lw-setup-navbar">
      <div className="mx-auto flex items-center justify-between px-6 md:px-8" style={{ maxWidth: "var(--lw-max-content)" }}>
        <BrandMark to="/" />
        {isLoggedIn ? (
          <UserAvatarMenu />
        ) : (
          <Link
            to="/"
            className="rounded-full px-5 py-2 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5"
            style={{
              background: "#fff",
              color: "#555",
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            返回首页
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Invoice Modal ─── */

type InvoiceType = "personal" | "enterprise";

const InvoiceModal = ({ onClose }: { onClose: () => void }) => {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("personal");
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isValidEmail = email.includes("@") && email.includes(".");
  const canSubmit =
    invoiceType === "personal"
      ? name.trim().length >= 2 && isValidEmail
      : name.trim().length >= 2 && taxId.trim().length >= 15 && isValidEmail;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      onClose();
    }, 1000);
  };

  const handleTypeSwitch = (type: InvoiceType) => {
    if (type === invoiceType) return;
    setInvoiceType(type);
    setName("");
    setTaxId("");
    setEmail("");
  };

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        className="relative mx-4 w-full max-w-md overflow-hidden rounded-2xl bg-white"
        style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 flex rounded-md p-1 transition-colors hover:bg-[rgba(0,0,0,0.04)]"
          style={{ color: "#aaa" }}
        >
          <X className="h-[18px] w-[18px]" />
        </button>

        <div className="px-7 pb-6 pt-7">
          <h3 className="m-0 text-[20px] font-bold tracking-[-0.3px]" style={{ color: "#333" }}>
            申请发票
          </h3>
          <p className="mb-5 mt-1 text-[13px]" style={{ color: "#999" }}>
            填写发票信息，电子发票将发送至您的邮箱。
          </p>

          {/* Type switcher */}
          <div className="mb-5 flex gap-1 rounded-lg p-1" style={{ background: "rgba(0,0,0,0.03)" }}>
            <button
              className="flex-1 rounded-md py-2 text-sm font-semibold transition-colors"
              style={{
                background: invoiceType === "personal" ? "var(--lw-accent)" : "transparent",
                color: invoiceType === "personal" ? "#fff" : "#999",
              }}
              onClick={() => handleTypeSwitch("personal")}
            >
              个人
            </button>
            <button
              className="flex-1 rounded-md py-2 text-sm font-semibold transition-colors"
              style={{
                background: invoiceType === "enterprise" ? "var(--lw-accent)" : "transparent",
                color: invoiceType === "enterprise" ? "#fff" : "#999",
              }}
              onClick={() => handleTypeSwitch("enterprise")}
            >
              企业
            </button>
          </div>

          {/* Name */}
          <div className="mb-4">
            <label className="lw-label mb-1.5 block">
              {invoiceType === "personal" ? "发票抬头" : "企业名称"} <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder={invoiceType === "personal" ? "请输入个人姓名" : "请输入企业全称"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="lw-input w-full"
              maxLength={60}
            />
          </div>

          {invoiceType === "enterprise" && (
            <div className="mb-4">
              <label className="lw-label mb-1.5 block">
                企业税号 <span style={{ color: "#cf3d4c" }}>*</span>
              </label>
              <input
                type="text"
                placeholder="请输入统一社会信用代码"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 20))}
                className="lw-input w-full"
                maxLength={20}
              />
            </div>
          )}

          {/* Email */}
          <div className="mb-6">
            <label className="lw-label mb-1.5 block">
              接收邮箱 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="email"
              placeholder="请输入邮箱地址"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="lw-input w-full"
            />
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border px-4 py-3 text-[15px] font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)]"
              style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
              className="lw-btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  提交中...
                </>
              ) : (
                "提交申请"
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Orders Page ─── */

export const AccountOrdersPage = () => {
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  return (
    <div className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden" style={{ color: "var(--lw-fg)" }}>
      <OrdersNavbar />

      <main className="relative z-10 flex-grow pb-16 pt-24">
        <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 960 }}>
          {/* Back link */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="mb-5"
          >
            <Link
              to="/account"
              className="inline-flex items-center gap-1 text-[13px] font-medium transition-colors hover:text-[#333]"
              style={{ color: "#aaa" }}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 返回账号信息
            </Link>
          </motion.div>

          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-6 flex items-start justify-between"
          >
            <div>
              <h1 className="m-0 text-2xl font-bold tracking-[-0.5px]" style={{ color: "#333" }}>
                订单历史
              </h1>
              <p className="mt-1.5 text-sm" style={{ color: "#999" }}>
                查看和管理您的支付历史记录。
              </p>
            </div>
            <button
              onClick={() => setShowInvoiceModal(true)}
              className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)]"
              style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
            >
              <FileText className="h-[15px] w-[15px]" />
              申请发票
            </button>
          </motion.div>

          {/* Orders Table */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="lw-setup-card overflow-hidden"
          >
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr style={{ background: "rgba(0,0,0,0.02)" }}>
                    <Th>订单号</Th>
                    <Th>描述</Th>
                    <Th>类型</Th>
                    <Th>时长</Th>
                    <Th align="center">数量</Th>
                    <Th align="right">金额</Th>
                    <Th>日期</Th>
                    <Th>状态</Th>
                  </tr>
                </thead>
                <tbody>
                  {mockOrders.map((order) => (
                    <tr
                      key={order.id}
                      className="transition-colors hover:bg-[rgba(0,0,0,0.02)]"
                    >
                      <Td>
                        <span className="font-mono text-[13px]" style={{ color: "#999" }}>
                          {order.id.slice(0, 10)}…
                        </span>
                      </Td>
                      <Td>{order.description}</Td>
                      <Td>{order.type}</Td>
                      <Td>
                        <span style={{ color: "#aaa" }}>{order.duration}</span>
                      </Td>
                      <Td align="center">{order.quantity}</Td>
                      <Td align="right">
                        <span className="font-mono">{order.amount}</span>
                      </Td>
                      <Td>
                        <span className="text-[13px]" style={{ color: "#999" }}>{order.date}</span>
                      </Td>
                      <Td>
                        <span
                          className="inline-block rounded-md px-2 py-0.5 text-xs font-semibold"
                          style={{ background: "rgba(20,122,86,0.08)", color: "#147A56" }}
                        >
                          {order.status}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div
              className="flex items-center justify-between border-t px-4 py-3"
              style={{ borderColor: "rgba(0,0,0,0.04)", background: "rgba(0,0,0,0.02)" }}
            >
              <span className="text-[13px]" style={{ color: "#aaa" }}>
                共 {mockOrders.length} 条数据
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[13px]" style={{ color: "#aaa" }}>10 条/页</span>
                <div className="flex gap-1">
                  <button
                    disabled
                    className="h-7 w-7 rounded border bg-white text-[13px] opacity-50"
                    style={{ borderColor: "rgba(0,0,0,0.06)", color: "#aaa", cursor: "not-allowed" }}
                  >
                    ‹
                  </button>
                  <button
                    className="h-7 w-7 rounded text-[13px] font-semibold"
                    style={{ background: "var(--lw-accent)", color: "#fff", cursor: "default" }}
                  >
                    1
                  </button>
                  <button
                    disabled
                    className="h-7 w-7 rounded border bg-white text-[13px] opacity-50"
                    style={{ borderColor: "rgba(0,0,0,0.06)", color: "#aaa", cursor: "not-allowed" }}
                  >
                    ›
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </section>
      </main>

      <LegalFooter />

      <AnimatePresence>
        {showInvoiceModal && (
          <InvoiceModal key="invoice" onClose={() => setShowInvoiceModal(false)} />
        )}
      </AnimatePresence>
    </div>
  );
};

/* ─── Table cells ─── */

const Th = ({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) => (
  <th
    className="whitespace-nowrap border-b px-4 py-3 text-[13px] font-semibold"
    style={{
      borderColor: "rgba(0,0,0,0.06)",
      color: "#666",
      textAlign: align,
    }}
  >
    {children}
  </th>
);

const Td = ({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) => (
  <td
    className="whitespace-nowrap border-b px-4 py-3.5 text-sm"
    style={{
      borderColor: "rgba(0,0,0,0.04)",
      color: "#333",
      textAlign: align,
    }}
  >
    {children}
  </td>
);
