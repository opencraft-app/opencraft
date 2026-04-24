import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUpRight, ArrowLeft, Check, User, Monitor, Clock, HardDrive, Settings, Zap, Headphones, X, RefreshCw } from "lucide-react";
import { useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";

/* ─── Notion DESIGN.md Tokens ─── */

const colors = {
  black: "rgba(0,0,0,0.95)",
  white: "#ffffff",
  primary: "rgba(0,0,0,0.90)",
  primaryHover: "rgba(0,0,0,0.75)",
  warmWhite: "#f6f5f4",
  warmGray500: "#615d59",
  warmGray300: "#a39e98",
  border: "rgba(0,0,0,0.1)",
  badgeBg: "rgba(0,0,0,0.04)",
  badgeText: "rgba(0,0,0,0.75)",
};

const shadows = {
  card: "rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px, rgba(0,0,0,0.01) 0px 0.175px 1.04px",
  deep: "rgba(0,0,0,0.01) 0px 1px 3px, rgba(0,0,0,0.02) 0px 3px 7px, rgba(0,0,0,0.02) 0px 7px 15px, rgba(0,0,0,0.04) 0px 14px 28px, rgba(0,0,0,0.05) 0px 23px 52px",
  featured: `rgba(0,0,0,0.10) 0px 0px 0px 3px, rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px`,
};

/* ─── Animation Variants (subtle, Notion-style) ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: (custom: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: custom * 0.08, duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  }),
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

/* ─── Plan Data ─── */

interface PlanFeature {
  icon: React.ReactNode;
  label: string;
  value?: string; // e.g. "1个", "至多2个"
  hasCheck?: boolean;
}

interface PlanInfo {
  name: string;
  badge?: string;
  badgeStyle?: "tag" | "popular";
  price: string;
  priceUnit?: string;
  priceNote?: string;
  description: string;
  features: PlanFeature[];
  ctaLabel: string;
  ctaStyle: "outline" | "primary" | "outline-dark";
  featured?: boolean;
}

const iconStyle = { width: 16, height: 16, color: colors.warmGray300, strokeWidth: 1.5 };

const plans: PlanInfo[] = [
  {
    name: "入门型",
    badge: "免费体验5天",
    badgeStyle: "tag",
    price: "¥49",
    priceUnit: "/月",
    description: "一键云端部署 Hermes Agent",
    features: [
      { icon: <User {...iconStyle} />, label: "Agent", value: "1 个" },
      { icon: <Monitor {...iconStyle} />, label: "独立环境", hasCheck: true },
      { icon: <Clock {...iconStyle} />, label: "7×24 在线", hasCheck: true },
      { icon: <HardDrive {...iconStyle} />, label: "专属云端存储", hasCheck: true },
      { icon: <Settings {...iconStyle} />, label: "极简配置面板", hasCheck: true },
    ],
    ctaLabel: "立即订阅",
    ctaStyle: "primary",
    featured: true,
  },
  {
    name: "进阶型",
    price: "¥139",
    priceUnit: "/月",
    description: "一键云端部署 Hermes Agent",
    features: [
      { icon: <User {...iconStyle} />, label: "Agent", value: "3 个" },
      { icon: <Monitor {...iconStyle} />, label: "独立环境", hasCheck: true },
      { icon: <Clock {...iconStyle} />, label: "7×24 在线", hasCheck: true },
      { icon: <HardDrive {...iconStyle} />, label: "专属云端存储", hasCheck: true },
      { icon: <Settings {...iconStyle} />, label: "极简配置面板", hasCheck: true },
      { icon: <Zap {...iconStyle} />, label: "新功能优先体验", hasCheck: true },
    ],
    ctaLabel: "立即订阅",
    ctaStyle: "outline-dark",
  },
  {
    name: "专业型",
    price: "¥669",
    priceUnit: "/月",
    description: "一键云端部署 Hermes Agent",
    features: [
      { icon: <User {...iconStyle} />, label: "Agent", value: "15 个" },
      { icon: <Monitor {...iconStyle} />, label: "独立环境", hasCheck: true },
      { icon: <Clock {...iconStyle} />, label: "7×24 在线", hasCheck: true },
      { icon: <HardDrive {...iconStyle} />, label: "专属云端存储", hasCheck: true },
      { icon: <Settings {...iconStyle} />, label: "极简配置面板", hasCheck: true },
      { icon: <Zap {...iconStyle} />, label: "新功能优先体验", hasCheck: true },
      { icon: <Headphones {...iconStyle} />, label: "优先技术支持", hasCheck: true },
    ],
    ctaLabel: "立即订阅",
    ctaStyle: "outline-dark",
  },
];

/* ─── Notion-style Navbar ─── */

const SubscribeNavbar = () => {
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
        borderBottom: `1px solid ${colors.border}`,
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
        <Link
            to="/"
            style={{
              fontSize: 15,
              fontWeight: 500,
              color: colors.warmGray500,
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = colors.primary; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray500; }}
          >
            返回首页
          </Link>
      </div>
    </header>
  );
};

/* ─── Plan Card Component ─── */

const PlanCard = ({
  plan,
  index,
  onSubscribe,
  subscribing,
}: {
  plan: PlanInfo;
  index: number;
  onSubscribe: () => void;
  subscribing: boolean;
}) => {
  const isFeatured = plan.featured;

  return (
    <motion.div
      variants={fadeIn}
      custom={index}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: colors.white,
        border: isFeatured ? `1.5px solid ${colors.primary}` : `1px solid ${colors.border}`,
        borderRadius: isFeatured ? 16 : 12,
        boxShadow: isFeatured ? shadows.featured : shadows.card,
        overflow: "hidden",
        transition: "box-shadow 0.3s, transform 0.3s",
      }}
      onMouseEnter={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.boxShadow = shadows.deep;
          e.currentTarget.style.transform = "translateY(-2px)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.boxShadow = shadows.card;
          e.currentTarget.style.transform = "translateY(0)";
        }
      }}
    >
      {/* Popular Badge */}
      {plan.badge && plan.badgeStyle === "popular" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 0",
            background: colors.primary,
            color: colors.white,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.125px",
            lineHeight: 1.33,
          }}
        >
          {plan.badge}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "32px 28px 28px" }}>
        {/* Header: Name + Tag Badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
          <h3
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.25px",
              lineHeight: 1.27,
              color: colors.black,
              margin: 0,
            }}
          >
            {plan.name}
          </h3>
          {plan.badge && plan.badgeStyle === "tag" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 10px",
                borderRadius: 9999,
                background: colors.badgeBg,
                color: colors.badgeText,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.125px",
                lineHeight: 1.33,
              }}
            >
              {plan.badge}
            </span>
          )}
        </div>

        {/* Price */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 8 }}>
          <span
            style={{
              fontSize: 48,
              fontWeight: 700,
              letterSpacing: "-1.5px",
              lineHeight: 1,
              color: colors.black,
            }}
          >
            {plan.price}
          </span>
          {(plan.priceUnit || plan.priceNote) && (
            <span
              style={{
                fontSize: 14,
                fontWeight: 400,
                color: colors.warmGray300,
                lineHeight: 1.43,
                marginLeft: 2,
              }}
            >
              {plan.priceUnit || plan.priceNote}
            </span>
          )}
        </div>

        {/* Description */}
        <p
          style={{
            fontSize: 14,
            fontWeight: 400,
            lineHeight: 1.43,
            color: colors.warmGray500,
            marginBottom: 28,
          }}
        >
          {plan.description}
        </p>

        {/* Divider */}
        <div style={{ height: 1, background: colors.border, marginBottom: 24 }} />

        {/* Features */}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {plan.features.map((feature, idx) => (
            <li
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 14,
                fontWeight: 400,
                lineHeight: 1.43,
                color: colors.warmGray500,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {feature.icon}
                <span>{feature.label}</span>
              </span>
              {feature.value ? (
                <span style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>
                  {feature.value}
                </span>
              ) : feature.hasCheck ? (
                <Check style={{ width: 16, height: 16, color: colors.primary, strokeWidth: 2 }} />
              ) : null}
            </li>
          ))}
        </ul>

        {/* CTA Button */}
        <div style={{ marginTop: 32 }}>
          {plan.ctaStyle === "primary" ? (
            <button
              onClick={onSubscribe}
              disabled={subscribing}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.33,
                cursor: subscribing ? "not-allowed" : "pointer",
                opacity: subscribing ? 0.6 : 1,
                transition: "background 0.2s, transform 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!subscribing) {
                  e.currentTarget.style.background = colors.primaryHover;
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.primary;
              }}
            >
              {subscribing ? "正在创建..." : plan.ctaLabel}
              {!subscribing && <ArrowUpRight style={{ width: 15, height: 15 }} />}
            </button>
          ) : (
            <button
              onClick={onSubscribe}
              disabled={subscribing}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                background: colors.white,
                color: colors.black,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.33,
                cursor: subscribing ? "not-allowed" : "pointer",
                opacity: subscribing ? 0.6 : 1,
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!subscribing) {
                  e.currentTarget.style.background = colors.warmWhite;
                  e.currentTarget.style.borderColor = "rgba(0,0,0,0.2)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.white;
                e.currentTarget.style.borderColor = colors.border;
              }}
            >
              {subscribing ? "正在创建..." : plan.ctaLabel}
              {!subscribing && <ArrowUpRight style={{ width: 15, height: 15 }} />}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
};

/* ─── Modal Overlay Shared ─── */

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
  backdropFilter: "blur(4px)",
};

const modalPanelStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: 440,
  margin: "0 16px",
  background: colors.white,
  borderRadius: 16,
  boxShadow: shadows.deep,
  overflow: "hidden",
};

const modalCloseStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  background: "none",
  border: "none",
  cursor: "pointer",
  color: colors.warmGray300,
  padding: 4,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "color 0.15s, background 0.15s",
};

/* ─── Confirm Order Modal ─── */

const ConfirmOrderModal = ({
  plan,
  onCancel,
  onPay,
}: {
  plan: PlanInfo;
  onCancel: () => void;
  onPay: () => void;
}) => {
  const priceNum = plan.price.replace(/[^0-9.]/g, "");

  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onCancel}
    >
      <motion.div
        style={modalPanelStyle}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          style={modalCloseStyle}
          onClick={onCancel}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px" }}>
          {/* Title */}
          <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 6px", letterSpacing: "-0.25px" }}>
            确认订单
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 20px" }}>订单详情</p>

          {/* Order details card */}
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: "20px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 14, color: colors.warmGray500 }}>
              <span>{plan.name}订阅</span>
              <span style={{ fontWeight: 600, color: colors.black }}>¥{priceNum}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: 14, color: colors.warmGray500 }}>
              <span>订阅周期</span>
              <span style={{ fontWeight: 600, color: colors.black }}>1个月</span>
            </div>
            <div style={{ height: 1, background: colors.border, margin: "0 0 16px" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: colors.warmGray500 }}>总计:</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: colors.black, letterSpacing: "-1px" }}>¥{priceNum}</span>
            </div>
          </div>

          {/* Payment method */}
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: "16px 20px",
              marginBottom: 24,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                border: `2px solid ${colors.primary}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: colors.primary }} />
            </div>
            <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, flexShrink: 0 }}>
              <circle cx="12" cy="12" r="12" fill="#07C160" />
              <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
              <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-0.6 1.6-1.5 1.6-2.5z" fill="#fff" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 500, color: colors.black }}>微信支付</span>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={onCancel}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
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
              onClick={onPay}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              支付 ¥{priceNum}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── WeChat QR Code Modal ─── */

const WechatQRModal = ({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) => {
  const [refreshKey, setRefreshKey] = useState(0);

  const mockQrValue = `https://lightclaw.tech/pay/mock?t=${Date.now()}&k=${refreshKey}`;

  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        style={{ ...modalPanelStyle, maxWidth: 400 }}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          style={modalCloseStyle}
          onClick={onClose}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 24px", letterSpacing: "-0.25px", textAlign: "left" }}>
            微信支付
          </h3>

          {/* QR Code */}
          <div
            style={{
              display: "inline-flex",
              padding: 16,
              borderRadius: 12,
              border: `1px solid ${colors.border}`,
              background: colors.white,
              marginBottom: 20,
            }}
          >
            <QRCodeSVG
              value={mockQrValue}
              size={200}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
              style={{ display: "block" }}
            />
          </div>

          <p style={{ fontSize: 14, fontWeight: 500, color: colors.black, margin: "0 0 4px" }}>
            请使用微信扫描二维码完成支付
          </p>
          <p style={{ fontSize: 13, color: colors.warmGray300, margin: "0 0 24px" }}>
            扫码后请在手机上完成操作
          </p>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "12px 16px",
                borderRadius: 8,
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
              <RefreshCw style={{ width: 15, height: 15 }} />
              刷新
            </button>
            <button
              onClick={onComplete}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              完成
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Subscribe Page ─── */

type ModalStep = "closed" | "confirm" | "qrcode";

export const SubscribePage = () => {
  const navigate = useNavigate();
  const [subscribing, setSubscribing] = useState(false);
  const [modalStep, setModalStep] = useState<ModalStep>("closed");
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);

  const handleSubscribe = useCallback((plan: PlanInfo) => {
    setSelectedPlan(plan);
    setModalStep("confirm");
  }, []);

  const handlePay = useCallback(() => {
    setModalStep("qrcode");
  }, []);

  const handleComplete = useCallback(() => {
    setModalStep("closed");
    setSubscribing(true);
    navigate("/openclaw/settings?creating=true");
  }, [navigate]);

  const handleCloseModal = useCallback(() => {
    setModalStep("closed");
    setSelectedPlan(null);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
      <SubscribeNavbar />

      <main style={{ flexGrow: 1, padding: "96px 24px 64px" }}>
        <section style={{ maxWidth: 1080, margin: "0 auto" }}>
          {/* Page Header — Notion style */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            style={{ marginBottom: 48, textAlign: "center" }}
          >
            <h1
              style={{
                fontSize: "clamp(1.625rem, 3vw, 2rem)",
                fontWeight: 700,
                letterSpacing: "-0.625px",
                lineHeight: 1.23,
                color: colors.black,
                margin: 0,
              }}
            >
              选择适合你的套餐
            </h1>
            <p
              style={{
                fontSize: 16,
                fontWeight: 400,
                lineHeight: 1.5,
                color: colors.warmGray500,
                marginTop: 8,
              }}
            >
              根据你的使用场景，选一个套餐开始 AI Agent 之旅。
            </p>
          </motion.div>

          {/* Plan Cards — 3 columns */}
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 24,
              maxWidth: 960,
              margin: "0 auto",
            }}
          >
            {plans.map((plan, idx) => (
              <PlanCard
                key={plan.name}
                plan={plan}
                index={idx}
                onSubscribe={() => handleSubscribe(plan)}
                subscribing={subscribing}
              />
            ))}
          </motion.div>

          {/* Back link */}
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <Link
              to="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 14,
                fontWeight: 400,
                color: colors.warmGray300,
                textDecoration: "none",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.primary; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray300; }}
            >
              <ArrowLeft style={{ width: 14, height: 14 }} /> 返回首页
            </Link>
          </div>
        </section>
      </main>

      <LegalFooter />

      {/* Payment Modals */}
      <AnimatePresence>
        {modalStep === "confirm" && selectedPlan && (
          <ConfirmOrderModal
            key="confirm"
            plan={selectedPlan}
            onCancel={handleCloseModal}
            onPay={handlePay}
          />
        )}
        {modalStep === "qrcode" && (
          <WechatQRModal
            key="qrcode"
            onClose={handleCloseModal}
            onComplete={handleComplete}
          />
        )}
      </AnimatePresence>

      {/* Responsive: collapse to single column on mobile */}
      <style>{`
        @media (max-width: 768px) {
          [style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
            max-width: 400px !important;
          }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          [style*="grid-template-columns: repeat(3"] {
            gap: 16px !important;
          }
        }
      `}</style>
    </div>
  );
};
