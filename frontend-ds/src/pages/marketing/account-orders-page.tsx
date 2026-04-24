import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, FileText, Loader2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "@/contexts/session-context";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";

/* ─── Tokens ─── */

const colors = {
  black: "rgba(0,0,0,0.95)",
  white: "#ffffff",
  warmWhite: "#f6f5f4",
  warmGray500: "#615d59",
  warmGray300: "#a39e98",
  border: "rgba(0,0,0,0.1)",
  borderSubtle: "rgba(0,0,0,0.06)",
  success: "#147a56",
  successBg: "rgba(20,122,86,0.08)",
  blue: "#0075de",
  primary: "rgba(0,0,0,0.90)",
  primaryHover: "rgba(0,0,0,0.75)",
};

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
  { id: "202604167832", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-04-16 21:52:02", status: "已完成" },
  { id: "202604021456", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-04-02 14:26:40", status: "已完成" },
  { id: "202603261893", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-03-26 20:47:05", status: "已完成" },
  { id: "202603262047", description: "活动赠送包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-03-26 20:46:56", status: "已完成" },
  { id: "202602231100", description: "基础体验包", type: "购买", duration: "–", quantity: 1, amount: "0.00 CNY", date: "2026-02-23 19:00:14", status: "已完成" },
];

/* ─── Navbar ─── */

const OrdersNavbar = () => {
  const { isAuthenticated: isLoggedIn } = useSession();

  return (
    <header
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        zIndex: 50,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(12px) saturate(180%)",
        WebkitBackdropFilter: "blur(12px) saturate(180%)",
        borderBottom: `1px solid ${colors.borderSubtle}`,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 56,
          padding: "0 24px",
        }}
      >
        <Link to="/" style={{ display: "flex", alignItems: "center" }}>
          <img
            src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5affb0c4-cfed-4614-aa34-6868d88f1717.svg"
            alt="LightClaw"
            style={{ height: 28, objectFit: "contain" }}
          />
        </Link>
        {isLoggedIn ? (
          <UserAvatarMenu />
        ) : (
          <Link
            to="/"
            style={{ fontSize: 14, fontWeight: 500, color: colors.warmGray500 }}
          >
            返回首页
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Table Header Cell ─── */

const Th = ({ children, width, align = "left" }: { children: React.ReactNode; width?: string | number; align?: "left" | "right" | "center" }) => (
  <th
    style={{
      padding: "12px 16px",
      fontSize: 13,
      fontWeight: 600,
      color: colors.warmGray500,
      textAlign: align,
      whiteSpace: "nowrap",
      borderBottom: `1px solid ${colors.border}`,
      background: colors.warmWhite,
      width,
    }}
  >
    {children}
  </th>
);

/* ─── Table Data Cell ─── */

const Td = ({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" | "center" }) => (
  <td
    style={{
      padding: "14px 16px",
      fontSize: 14,
      color: colors.black,
      textAlign: align,
      whiteSpace: "nowrap",
      borderBottom: `1px solid ${colors.borderSubtle}`,
    }}
  >
    {children}
  </td>
);

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

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    fontSize: 14,
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    outline: "none",
    background: colors.white,
    color: colors.black,
    transition: "border-color 0.15s",
  };

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px 0",
    fontSize: 14,
    fontWeight: 600,
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    transition: "all 0.15s",
    background: active ? colors.primary : "transparent",
    color: active ? colors.white : colors.warmGray500,
  });

  return (
    <motion.div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(4px)",
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 440,
          margin: "0 16px",
          background: colors.white,
          borderRadius: 8,
          boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)",
          overflow: "hidden",
        }}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: colors.warmGray300,
            padding: 4,
            borderRadius: 4,
            display: "flex",
          }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px" }}>
          {/* Title */}
          <h3 style={{ fontSize: 20, fontWeight: 700, color: colors.black, margin: "0 0 4px", letterSpacing: "-0.3px" }}>
            申请发票
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 20px" }}>
            填写发票信息，电子发票将发送至您的邮箱。
          </p>

          {/* Type switcher */}
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: 4,
              borderRadius: 8,
              background: colors.warmWhite,
              marginBottom: 20,
            }}
          >
            <button style={tabBtnStyle(invoiceType === "personal")} onClick={() => handleTypeSwitch("personal")}>
              个人
            </button>
            <button style={tabBtnStyle(invoiceType === "enterprise")} onClick={() => handleTypeSwitch("enterprise")}>
              企业
            </button>
          </div>

          {/* Form */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
              {invoiceType === "personal" ? "发票抬头" : "企业名称"} <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder={invoiceType === "personal" ? "请输入个人姓名" : "请输入企业全称"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.blue; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.border; }}
              maxLength={60}
            />
          </div>

          {invoiceType === "enterprise" && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
                企业税号 <span style={{ color: "#cf3d4c" }}>*</span>
              </label>
              <input
                type="text"
                placeholder="请输入统一社会信用代码"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 20))}
                style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = colors.blue; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = colors.border; }}
                maxLength={20}
              />
            </div>
          )}

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
              接收邮箱 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="email"
              placeholder="请输入邮箱地址"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.blue; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.border; }}
            />
          </div>

          {/* Buttons */}
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={onClose}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 6,
                border: `1px solid ${colors.border}`,
                background: colors.white,
                color: colors.black,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "12px 16px",
                borderRadius: 6,
                border: "none",
                background: canSubmit ? colors.primary : "rgba(0,0,0,0.12)",
                color: canSubmit ? colors.white : colors.warmGray300,
                fontSize: 15,
                fontWeight: 600,
                cursor: canSubmit && !submitting ? "pointer" : "not-allowed",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { if (canSubmit && !submitting) e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { if (canSubmit) e.currentTarget.style.background = colors.primary; }}
            >
              {submitting ? (
                <>
                  <Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />
                  提交中...
                </>
              ) : (
                "提交申请"
              )}
            </button>
          </div>
        </div>

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </motion.div>
    </motion.div>
  );
};

/* ─── Orders Page ─── */

export const AccountOrdersPage = () => {
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
      <OrdersNavbar />

      <main style={{ flexGrow: 1, padding: "88px 24px 64px" }}>
        <section style={{ maxWidth: 960, margin: "0 auto" }}>
          {/* Back link */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            style={{ marginBottom: 20 }}
          >
            <Link
              to="/account"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 13,
                fontWeight: 500,
                color: colors.warmGray300,
                textDecoration: "none",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.black; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray300; }}
            >
              <ArrowLeft style={{ width: 14, height: 14 }} /> 返回账号信息
            </Link>
          </motion.div>

          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            style={{ marginBottom: 24, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}
          >
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 700, color: colors.black, margin: 0, letterSpacing: "-0.5px" }}>
                订单历史
              </h1>
              <p style={{ fontSize: 14, color: colors.warmGray500, marginTop: 6 }}>
                查看和管理您的支付历史记录。
              </p>
            </div>
            <button
              onClick={() => setShowInvoiceModal(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                borderRadius: 6,
                border: `1px solid ${colors.border}`,
                background: colors.white,
                color: colors.black,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
                flexShrink: 0,
                marginTop: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
            >
              <FileText style={{ width: 15, height: 15 }} />
              申请发票
            </button>
          </motion.div>

          {/* Orders Table */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
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
                      style={{ transition: "background 0.1s" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <Td>
                        <span style={{ fontFamily: "monospace", fontSize: 13, color: colors.warmGray500 }}>
                          {order.id.slice(0, 10)}…
                        </span>
                      </Td>
                      <Td>{order.description}</Td>
                      <Td>{order.type}</Td>
                      <Td>
                        <span style={{ color: colors.warmGray300 }}>{order.duration}</span>
                      </Td>
                      <Td align="center">{order.quantity}</Td>
                      <Td align="right">
                        <span style={{ fontFamily: "monospace" }}>{order.amount}</span>
                      </Td>
                      <Td>
                        <span style={{ fontSize: 13, color: colors.warmGray500 }}>{order.date}</span>
                      </Td>
                      <Td>
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 12,
                            fontWeight: 600,
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: colors.successBg,
                            color: colors.success,
                          }}
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
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                borderTop: `1px solid ${colors.borderSubtle}`,
                background: colors.warmWhite,
              }}
            >
              <span style={{ fontSize: 13, color: colors.warmGray300 }}>
                共 {mockOrders.length} 条数据
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: colors.warmGray300 }}>10 条/页</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    disabled
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 4,
                      border: `1px solid ${colors.borderSubtle}`,
                      background: colors.white,
                      color: colors.warmGray300,
                      fontSize: 13,
                      cursor: "not-allowed",
                      opacity: 0.5,
                    }}
                  >
                    ‹
                  </button>
                  <button
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 4,
                      border: "none",
                      background: colors.black,
                      color: colors.white,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "default",
                    }}
                  >
                    1
                  </button>
                  <button
                    disabled
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 4,
                      border: `1px solid ${colors.borderSubtle}`,
                      background: colors.white,
                      color: colors.warmGray300,
                      fontSize: 13,
                      cursor: "not-allowed",
                      opacity: 0.5,
                    }}
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

      {/* Invoice Modal */}
      <AnimatePresence>
        {showInvoiceModal && (
          <InvoiceModal key="invoice" onClose={() => setShowInvoiceModal(false)} />
        )}
      </AnimatePresence>
    </div>
  );
};
