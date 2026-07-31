import { useState, type ReactElement } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trash2 } from "lucide-react";
import { useT, t as rawT } from "@/i18n/t";

export interface SavedCard {
  id: string;
  brand: "visa" | "mastercard" | "amex";
  last4: string;
  expiry: string;
  holderName: string;
  isDefault: boolean;
}

/** 格式化有效期输入：纯数字串 → MM/YY */
export const formatExpiry = (v: string): string => {
  const d = v.replace(/\D/g, "").slice(0, 4);
  return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

/** 按卡号前缀识别品牌 */
export const detectBrand = (cardNumber: string): "visa" | "mastercard" | "amex" => {
  const d = cardNumber.replace(/\D/g, "");
  if (d.startsWith("4")) return "visa";
  if (d.startsWith("5")) return "mastercard";
  if (d.startsWith("3")) return "amex";
  return "visa";
};

/** 校验绑卡表单输入，返回错误文案 key 或 null（无错误） */
export const validateCardInput = (
  cardNumber: string,
  expiry: string,
  cvc: string,
  holder: string,
): string | null => {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 13) return "请输入有效的卡号。";
  if (!/^\d{2}\/\d{2}$/.test(expiry)) return "有效期格式应为 MM/YY。";
  const [mm] = expiry.split("/");
  if (Number(mm) < 1 || Number(mm) > 12) return "有效期月份应在 01-12 之间。";
  if (cvc.replace(/\D/g, "").length < 3) return "安全码无效。";
  if (!holder.trim()) return "请输入持卡人姓名。";
  return null;
};

/**
 * i18n 注册：validateCardInput 返回的中文源文案通过 rawT() 注册，
 * 使 i18n-extract 脚本能扫描到并生成 hash key。
 * 运行时 rawT 在模块加载时执行一次，结果不使用（仅用于注册）。
 */
void [
  rawT("请输入有效的卡号。"),
  rawT("有效期格式应为 MM/YY。"),
  rawT("有效期月份应在 01-12 之间。"),
  rawT("安全码无效。"),
  rawT("请输入持卡人姓名。"),
];

/** 预置 3 张演示卡（含 1 张默认） */
export const buildInitialCards = (): SavedCard[] => [
  { id: "demo-1", brand: "visa", last4: "4242", expiry: "12/27", holderName: "John Doe", isDefault: true },
  { id: "demo-2", brand: "mastercard", last4: "5555", expiry: "08/26", holderName: "John Doe", isDefault: false },
  { id: "demo-3", brand: "amex", last4: "3782", expiry: "03/28", holderName: "John Doe", isDefault: false },
];

// ─── SavedCardsSection 组件 ───

let _cardIdCounter = 100;
const nextCardId = () => `card-${++_cardIdCounter}`;

const brandLabel = (brand: SavedCard["brand"]): string =>
  brand === "visa" ? "Visa" : brand === "mastercard" ? "Mastercard" : "Amex";

/**
 * 卡管理组件：卡列表 + 绑卡 + 设为默认 + 解绑。
 * 纯前端占位实现：数据仅存 useState，不发起后端请求。
 * CVC 不存入 SavedCard（PCI 口径）。
 */
export const SavedCardsSection = (): ReactElement => {
  const t = useT();
  const [cards, setCards] = useState<SavedCard[]>(() => buildInitialCards());
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // 绑卡表单状态
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = (): void => {
    setCardNumber("");
    setExpiry("");
    setCvc("");
    setHolder("");
    setFormError(null);
  };

  const handleSaveCard = (): void => {
    // validateCardInput 返回中文源文案，通过 t() 解析为当前 locale 翻译
    const errMsg = validateCardInput(cardNumber, expiry, cvc, holder);
    if (errMsg) {
      setFormError(t(errMsg));
      return;
    }
    const digits = cardNumber.replace(/\D/g, "");
    const newCard: SavedCard = {
      id: nextCardId(),
      brand: detectBrand(cardNumber),
      last4: digits.slice(-4),
      expiry,
      holderName: holder.trim(),
      isDefault: cards.length === 0, // 首张卡自动默认
    };
    setCards((prev) => [...prev, newCard]);
    resetForm();
    setShowAddForm(false);
  };

  const handleSetDefault = (id: string): void => {
    setCards((prev) => prev.map((c) => ({ ...c, isDefault: c.id === id })));
  };

  const handleConfirmRemove = (id: string): void => {
    setCards((prev) => {
      // 防御性拦截：默认卡不允许解绑；仅剩一张时不允许解绑
      const target = prev.find((c) => c.id === id);
      if (!target || target.isDefault || prev.length <= 1) {
        return prev;
      }
      return prev.filter((c) => c.id !== id);
    });
    setConfirmRemoveId(null);
  };

  const inputClassName =
    "h-11 w-full rounded-md border px-3 text-sm outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--lw-accent)_25%,transparent)]";

  // 待确认解绑的卡对象（驱动弹窗展示）
  const confirmCard = confirmRemoveId ? cards.find((c) => c.id === confirmRemoveId) ?? null : null;

  return (
    <div
      className="overflow-hidden bg-white"
      style={{ border: "1px solid #E6E9EF", borderRadius: 16 }}
    >
      {/* Header — 与订阅套餐区块一致 */}
      <div
        className="flex items-center justify-between px-5 py-5 md:px-8 md:py-8"
        style={{ borderBottom: "1px solid #E6E9EF" }}
      >
        <h3 className="text-[18px] md:text-[20px]" style={{ fontWeight: 500, color: "rgba(0,0,0,0.9)", lineHeight: 1.6 }}>
          {t("签约卡管理")}
        </h3>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="text-sm font-semibold transition-colors"
            style={{ color: "var(--lw-accent)" }}
          >
            {t("添加卡片")}
          </button>
        )}
      </div>

      {/* 内容区 */}
      <div className="px-5 py-6 md:px-8 md:py-8">
        {/* 卡列表 */}
        {cards.length === 0 && !showAddForm ? (
          <p className="py-8 text-center text-sm" style={{ color: "#999" }}>{t("还没有绑定卡片")}</p>
        ) : (
          <div className="space-y-5">
            {cards.map((card, idx) => (
              <div key={card.id}>
                {idx > 0 && <div className="mb-5" style={{ height: 1, background: "rgba(0,0,0,0.06)" }} />}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-bold" style={{ color: "#333" }}>{brandLabel(card.brand)}</span>
                      <span style={{ color: "#999" }}>•••• {card.last4}</span>
                      {card.isDefault && (
                        <span
                          className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold"
                          style={{ background: "rgba(230,111,98,0.06)", color: "var(--lw-accent)", borderRadius: "6px" }}
                        >
                          {t("默认")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs" style={{ color: "#999" }}>{card.expiry} · {card.holderName}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    {!card.isDefault && (
                      <button type="button" onClick={() => handleSetDefault(card.id)} className="text-sm font-medium" style={{ color: "#666" }}>
                        {t("设为默认")}
                      </button>
                    )}
                    {/* 默认卡不允许解绑；仅剩一张卡时不允许解绑 */}
                    {!card.isDefault && cards.length > 1 && (
                      <button type="button" onClick={() => setConfirmRemoveId(card.id)} className="text-sm font-medium" style={{ color: "#cf3d4c" }}>{t("解绑")}</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 绑卡表单（内联展开） */}
        {showAddForm && (
          <div className={cards.length > 0 ? "mt-6 pt-6" : ""} style={cards.length > 0 ? { borderTop: "1px solid rgba(0,0,0,0.06)" } : undefined}>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium" style={{ color: "#333" }}>{t("卡号")}</label>
                <input
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  placeholder={t("卡号")}
                  className={inputClassName}
                  style={{ borderColor: "#E6E9EF" }}
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium" style={{ color: "#333" }}>{t("有效期")}</label>
                  <input
                    value={expiry}
                    onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                    placeholder="MM/YY"
                    className={inputClassName}
                    style={{ borderColor: "#E6E9EF" }}
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium" style={{ color: "#333" }}>{t("安全码")}</label>
                  <input
                    value={cvc}
                    onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="CVC"
                    className={inputClassName}
                    style={{ borderColor: "#E6E9EF" }}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium" style={{ color: "#333" }}>{t("持卡人姓名")}</label>
                <input
                  value={holder}
                  onChange={(e) => setHolder(e.target.value)}
                  placeholder={t("持卡人姓名")}
                  className={inputClassName}
                  style={{ borderColor: "#E6E9EF" }}
                />
              </div>
              {/* formError 已通过 t() 翻译为当前 locale 文案 */}
              {formError && <p className="text-sm" style={{ color: "#cf3d4c" }}>{formError}</p>}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { resetForm(); setShowAddForm(false); }}
                  className="rounded-full px-5 py-2.5 text-sm font-medium transition-colors"
                  style={{ color: "#666" }}
                >
                  {t("取消")}
                </button>
                <button
                  type="button"
                  onClick={handleSaveCard}
                  className="inline-flex items-center justify-center rounded-full bg-[#202020] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-black"
                >
                  {t("保存")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 解绑确认弹窗 */}
      <AnimatePresence>
        {confirmCard && (
          <motion.div
            className="fixed inset-0 z-[100] flex items-center justify-center"
            style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setConfirmRemoveId(null)}
          >
            <motion.div
              className="relative mx-4 w-full max-w-[420px] overflow-hidden rounded-2xl bg-white"
              style={{ boxShadow: "0 20px 60px -10px rgba(0,0,0,0.2)" }}
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-7 pb-6 pt-7">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "rgba(207,61,76,0.08)" }}>
                    <Trash2 className="h-[18px] w-[18px]" style={{ color: "#cf3d4c" }} />
                  </div>
                  <h3 className="m-0 text-[16px] font-bold tracking-[-0.25px]" style={{ color: "#333" }}>
                    {t("解绑卡片")}
                  </h3>
                </div>
                <p className="text-sm leading-relaxed" style={{ margin: "12px 0 24px 0", color: "#666" }}>
                  {t("确认解绑 {{brand}} •••• {{last4}} 吗？解绑后该卡将从你的账户移除。", {
                    brand: brandLabel(confirmCard.brand),
                    last4: confirmCard.last4,
                  })}
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(null)}
                    className="flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[rgba(0,0,0,0.03)]"
                    style={{ borderColor: "rgba(0,0,0,0.1)", color: "#333" }}
                  >
                    {t("取消")}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfirmRemove(confirmCard.id)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors"
                    style={{ background: "#cf3d4c" }}
                  >
                    {t("确认解绑")}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SavedCardsSection;
