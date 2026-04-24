import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  Check,
  ChevronRight,
  Loader2,
  LogOut,
  Pencil,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "@/contexts/session-context";
import { LoginModal } from "@/components/site/login-modal";
import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { avatarImageUrl } from "@/lib/avatar-image";

/* ─── Tokens ─── */

const colors = {
  black: "rgba(0,0,0,0.95)",
  white: "#ffffff",
  primary: "rgba(0,0,0,0.90)",
  primaryHover: "rgba(0,0,0,0.75)",
  warmWhite: "#f6f5f4",
  warmGray500: "#615d59",
  warmGray300: "#a39e98",
  border: "rgba(0,0,0,0.1)",
  borderSubtle: "rgba(0,0,0,0.06)",
  success: "#147a56",
  successBg: "rgba(20,122,86,0.08)",
  warning: "#c67b1e",
  warningBg: "rgba(198,123,30,0.08)",
  blue: "#0075de",
};

/* ─── Animation ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 0.1, 0.25, 1] } },
};

/* ─── Navbar ─── */

const AccountNavbar = () => {
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
            style={{ fontSize: 14, fontWeight: 500, color: colors.warmGray500, transition: "color 0.2s" }}
          >
            返回首页
          </Link>
        )}
      </div>
    </header>
  );
};

/* ─── Info Row ─── */

const InfoRow = ({
  label,
  children,
  borderBottom = true,
}: {
  label: string;
  children: React.ReactNode;
  borderBottom?: boolean;
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 0",
      borderBottom: borderBottom ? `1px solid ${colors.borderSubtle}` : "none",
    }}
  >
    <span style={{ fontSize: 14, color: colors.warmGray500, flexShrink: 0 }}>{label}</span>
    <div style={{ fontSize: 14, fontWeight: 500, color: colors.black, textAlign: "right" }}>{children}</div>
  </div>
);

/* ─── Verify Identity Modal ─── */

const VerifyIdentityModal = ({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (name: string) => void;
}) => {
  const [realName, setRealName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = realName.trim().length >= 2 && idNumber.trim().length === 18;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    // Mock：1s 后成功
    setTimeout(() => {
      setSubmitting(false);
      onSuccess(realName.trim());
    }, 1000);
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
          maxWidth: 480,
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
          {/* Header */}
          <h3 style={{ fontSize: 20, fontWeight: 700, color: colors.black, margin: "0 0 4px", letterSpacing: "-0.3px" }}>
            实名认证
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 24px" }}>
            完成实名认证后可以发布技能和参与更多社区活动
          </p>

          {/* Status banner */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              background: colors.warmWhite,
              borderRadius: 6,
              marginBottom: 24,
              border: `1px solid ${colors.borderSubtle}`,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "rgba(67,108,240,0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Shield style={{ width: 18, height: 18, color: "#436cf0" }} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: colors.black, margin: 0 }}>认证状态：待提交</p>
              <p style={{ fontSize: 12, color: colors.warmGray500, margin: "2px 0 0" }}>请完整填写以下信息并提交认证申请</p>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: colors.borderSubtle, marginBottom: 20 }} />

          {/* Form */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
              证件类型
            </label>
            <div
              style={{
                ...inputStyle,
                background: colors.warmWhite,
                color: colors.warmGray500,
                cursor: "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>身份证</span>
              <ChevronRight style={{ width: 14, height: 14, color: colors.warmGray300, transform: "rotate(90deg)" }} />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
              真实姓名 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder="请输入真实姓名"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.blue; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.border as string; }}
              maxLength={20}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: colors.black, marginBottom: 6 }}>
              身份证号 <span style={{ color: "#cf3d4c" }}>*</span>
            </label>
            <input
              type="text"
              placeholder="请输入身份证号码"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value.replace(/[^0-9Xx]/g, "").slice(0, 18))}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = colors.blue; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = colors.border as string; }}
              maxLength={18}
            />
          </div>

          {error && (
            <p style={{ fontSize: 13, color: "#cf3d4c", marginBottom: 16 }}>{error}</p>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%",
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
          >
            {submitting ? (
              <>
                <Loader2 style={{ width: 16, height: 16, animation: "spin 1s linear infinite" }} />
                提交中...
              </>
            ) : (
              "提交认证"
            )}
          </button>

          {/* Privacy note */}
          <p style={{ fontSize: 12, color: colors.warmGray300, marginTop: 16, textAlign: "center", lineHeight: 1.6 }}>
            你的姓名和身份证号将加密传输并存储，平台仅保留脱敏信息用于展示。认证信息不会用于其他用途。
          </p>
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

/* ─── Main Account Page ─── */

export const AccountPage = () => {
  const navigate = useNavigate();
  const { session, isAuthenticated, authReady, signInAsGuest, updateProfile, uploadAvatar, signOut, deleteAccount } = useSession();
  const user = session.user;
  const subscription = session.currentSubscription;

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Login modal state (for unauthenticated view)
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);

  // Mock verification state
  const [verified, setVerified] = useState(false);
  const [verifiedName, setVerifiedName] = useState<string | null>(null);
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  const avatarSrc = avatarImageUrl(user?.avatarUrl ?? null);

  // Mock login method
  const loginMethod = (user?.phone ?? "").length > 0 ? "phone" : "wechat";

  const handleSaveName = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await updateProfile({ name: editName.trim() });
      setIsEditingName(false);
    } catch (e) {
      console.error("Failed to update name", e);
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      await uploadAvatar(file);
    } catch (err) {
      console.error("Failed to upload avatar", err);
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  };

  const handleVerifySuccess = (name: string) => {
    // 脱敏处理
    const masked = name.length <= 1 ? name : name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
    setVerified(true);
    setVerifiedName(masked);
    setShowVerifyModal(false);
  };

  const subscriptionLabel = subscription?.code === "pro"
    ? "专业型"
    : subscription?.code === "lite"
      ? "入门型"
      : subscription
        ? "体验版"
        : "未订阅";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
      <AccountNavbar />

      {/* ── Unauthenticated: login guide ── */}
      {authReady && !isAuthenticated ? (
        <main style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "88px 24px 64px" }}>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            style={{ textAlign: "center", maxWidth: 360 }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: colors.warmWhite,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 24px",
                border: `1px solid ${colors.borderSubtle}`,
              }}
            >
              <img
                src="https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png"
                alt="LightClaw"
                style={{ width: 48, height: 48, objectFit: "contain", pointerEvents: "none" }}
              />
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: colors.black, margin: "0 0 8px", letterSpacing: "-0.3px" }}>
              登录以查看账号信息
            </h2>
            <p style={{ fontSize: 14, color: colors.warmGray500, margin: "0 0 32px", lineHeight: 1.6 }}>
              登录后可查看和管理你的个人信息、订阅套餐和订单记录。
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                onClick={() => setShowLoginModal(true)}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: colors.primary,
                  color: colors.white,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
              >
                登录 / 注册
              </button>
              <button
                onClick={() => {
                  setGuestLoading(true);
                  setGuestError(null);
                  signInAsGuest()
                    .catch(() => setGuestError("游客登录失败，请稍后重试。"))
                    .finally(() => setGuestLoading(false));
                }}
                disabled={guestLoading}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  borderRadius: 6,
                  border: `1px solid ${colors.border}`,
                  background: colors.white,
                  color: colors.warmGray500,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: guestLoading ? "not-allowed" : "pointer",
                  opacity: guestLoading ? 0.6 : 1,
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (!guestLoading) e.currentTarget.style.background = colors.warmWhite; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
              >
                {guestLoading ? "进入中..." : "游客体验"}
              </button>
            </div>

            {guestError && (
              <p style={{ fontSize: 13, color: "#cf3d4c", marginTop: 12, textAlign: "center" }}>{guestError}</p>
            )}

            <Link
              to="/"
              style={{
                display: "inline-block",
                marginTop: 24,
                fontSize: 13,
                color: colors.warmGray300,
                textDecoration: "none",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.warmGray500; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray300; }}
            >
              ← 返回首页
            </Link>
          </motion.div>

          <LoginModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
        </main>
      ) : !authReady ? (
        <main style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "88px 24px 64px" }}>
          <p style={{ fontSize: 14, color: colors.warmGray300 }}>正在恢复会话...</p>
        </main>
      ) : (
      /* ── Authenticated: account info ── */
      <main style={{ flexGrow: 1, padding: "88px 24px 64px" }}>
        <section style={{ maxWidth: 640, margin: "0 auto" }}>
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            style={{ marginBottom: 32 }}
          >
            <h1 style={{ fontSize: 24, fontWeight: 700, color: colors.black, margin: 0, letterSpacing: "-0.5px" }}>
              账号信息
            </h1>
            <p style={{ fontSize: 14, color: colors.warmGray500, marginTop: 6 }}>
              管理你的个人信息和账号设置。
            </p>
          </motion.div>

          {/* Profile Card */}
          <motion.div
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 8,
              background: colors.white,
              overflow: "hidden",
            }}
          >
            {/* Card Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "14px 20px",
                borderBottom: `1px solid ${colors.borderSubtle}`,
                background: colors.warmWhite,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 700, color: colors.black }}>个人信息</span>
            </div>

            {/* Card Body */}
            <div style={{ padding: "4px 20px" }}>
              {/* Avatar + Nickname row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "20px 0",
                  borderBottom: `1px solid ${colors.borderSubtle}`,
                }}
              >
                {/* Avatar */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => void handleAvatarUpload(e)}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={avatarUploading}
                    style={{
                      position: "relative",
                      display: "block",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <img
                      src={avatarSrc}
                      alt="avatar"
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 8,
                        objectFit: "cover",
                        border: `1px solid ${colors.border}`,
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(0,0,0,0.25)",
                        borderRadius: 8,
                        opacity: 0,
                        transition: "opacity 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "0"; }}
                    >
                      {avatarUploading ? (
                        <Loader2 style={{ width: 18, height: 18, color: colors.white, animation: "spin 1s linear infinite" }} />
                      ) : (
                        <Camera style={{ width: 18, height: 18, color: colors.white }} />
                      )}
                    </div>
                  </button>
                </div>

                {/* Nickname */}
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 12, color: colors.warmGray300, display: "block", marginBottom: 4 }}>昵称</span>
                  {isEditingName ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={{
                          flex: 1,
                          padding: "6px 10px",
                          fontSize: 14,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 4,
                          outline: "none",
                          color: colors.black,
                        }}
                        maxLength={20}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") void handleSaveName(); }}
                      />
                      <button
                        onClick={() => void handleSaveName()}
                        disabled={saving || !editName.trim()}
                        style={{
                          padding: "6px 8px",
                          borderRadius: 4,
                          border: "none",
                          background: colors.blue,
                          color: colors.white,
                          cursor: "pointer",
                          display: "flex",
                        }}
                      >
                        {saving ? <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} /> : <Check style={{ width: 14, height: 14 }} />}
                      </button>
                      <button
                        onClick={() => { setIsEditingName(false); setEditName(user?.name ?? ""); }}
                        style={{
                          padding: "6px 8px",
                          borderRadius: 4,
                          border: "none",
                          background: "none",
                          color: colors.warmGray300,
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: colors.black }}>
                        {user?.name || "未设置"}
                      </span>
                      <button
                        onClick={() => { setEditName(user?.name ?? ""); setIsEditingName(true); }}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: colors.warmGray300,
                          padding: 2,
                          display: "flex",
                        }}
                      >
                        <Pencil style={{ width: 13, height: 13 }} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => { void signOut(); navigate("/"); }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: `1px solid ${colors.border}`,
                      background: colors.white,
                      color: colors.warmGray300,
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.warmGray500; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; e.currentTarget.style.color = colors.warmGray300; }}
                  >
                    <LogOut style={{ width: 12, height: 12 }} />
                    退出登录
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm("确定要注销账号吗？此操作不可恢复。")) {
                        void deleteAccount().then(() => navigate("/"));
                      }
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: `1px solid rgba(207,61,76,0.15)`,
                      background: colors.white,
                      color: colors.warmGray300,
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(207,61,76,0.04)"; e.currentTarget.style.color = "#cf3d4c"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; e.currentTarget.style.color = colors.warmGray300; }}
                  >
                    <Trash2 style={{ width: 12, height: 12 }} />
                    注销账号
                  </button>
                </div>
              </div>

              {/* Login method */}
              <InfoRow label="登录账号">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {loginMethod === "wechat" ? (
                    <>
                      <svg viewBox="0 0 24 24" style={{ width: 16, height: 16, flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="12" fill="#07C160" />
                        <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
                        <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-0.6 1.6-1.5 1.6-2.5z" fill="#fff" />
                      </svg>
                      <span>微信登录</span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 13, color: colors.warmGray500 }}>
                        {user?.phone ? user.phone.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2") : "手机登录"}
                      </span>
                    </>
                  )}
                </div>
              </InfoRow>

              {/* Verification status */}
              <InfoRow label="实名认证">
                {verified ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <ShieldCheck style={{ width: 14, height: 14, color: colors.success }} />
                    <span style={{ color: colors.success, fontWeight: 600 }}>{verifiedName}</span>
                    <span
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: colors.successBg,
                        color: colors.success,
                        fontWeight: 600,
                      }}
                    >
                      已认证
                    </span>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: colors.warningBg,
                        color: colors.warning,
                        fontWeight: 600,
                      }}
                    >
                      未认证
                    </span>
                    <button
                      onClick={() => setShowVerifyModal(true)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 600,
                        color: colors.blue,
                        padding: 0,
                      }}
                    >
                      去认证
                    </button>
                  </div>
                )}
              </InfoRow>

              {/* Subscription */}
              <InfoRow label="当前订阅" borderBottom={false}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{subscriptionLabel}</span>
                  {subscription && (
                    <span
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: colors.successBg,
                        color: colors.success,
                        fontWeight: 600,
                      }}
                    >
                      生效中
                    </span>
                  )}
                </div>
              </InfoRow>
            </div>

            {/* Card Footer */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: `1px solid ${colors.borderSubtle}`,
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => navigate("/account/orders")}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: `1px solid ${colors.border}`,
                  background: colors.white,
                  color: colors.black,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
              >
                查看订单
                <ChevronRight style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </motion.div>
        </section>
      </main>
      )}

      <LegalFooter />

      {/* Verify Identity Modal */}
      <AnimatePresence>
        {showVerifyModal && (
          <VerifyIdentityModal
            key="verify"
            onClose={() => setShowVerifyModal(false)}
            onSuccess={handleVerifySuccess}
          />
        )}
      </AnimatePresence>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
