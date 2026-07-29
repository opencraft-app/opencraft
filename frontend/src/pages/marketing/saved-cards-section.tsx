import { useState } from "react";
import { useT } from "@/i18n/t";

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
export const SavedCardsSection = (): JSX.Element => {
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
    // validateCardInput 返回中文文案（非 i18n key），直接使用无需 t() 包裹
    const errMsg = validateCardInput(cardNumber, expiry, cvc, holder);
    if (errMsg) {
      setFormError(errMsg);
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
      const next = prev.filter((c) => c.id !== id);
      // 移除的是默认卡且列表非空：自动选剩余首张为默认
      const removedWasDefault = prev.find((c) => c.id === id)?.isDefault ?? false;
      if (removedWasDefault && next.length > 0) {
        next[0] = { ...next[0], isDefault: true };
      }
      return next;
    });
    setConfirmRemoveId(null);
  };

  return (
    <section className="mx-auto px-6 md:px-8" style={{ maxWidth: 800 }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">{t("签约卡管理")}</h2>
        {!showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            {t("添加卡片")}
          </button>
        )}
      </div>

      {/* 卡列表 */}
      {cards.length === 0 ? (
        <p className="text-sm text-gray-500 py-8 text-center">{t("还没有绑定卡片")}</p>
      ) : (
        <ul className="space-y-3">
          {cards.map((card) => (
            <li key={card.id} className="flex items-center justify-between p-4 rounded-lg border border-gray-200">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{brandLabel(card.brand)}</span>
                  <span className="text-gray-500">•••• {card.last4}</span>
                  {card.isDefault && (
                    <span className="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700">{t("默认")}</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">{card.expiry} · {card.holderName}</p>
              </div>
              <div className="flex items-center gap-2">
                {!card.isDefault && (
                  <button type="button" onClick={() => handleSetDefault(card.id)} className="text-sm text-gray-600 hover:underline">
                    {t("设为默认")}
                  </button>
                )}
                {confirmRemoveId === card.id ? (
                  <>
                    <button type="button" onClick={() => handleConfirmRemove(card.id)} className="text-sm text-red-600 hover:underline">{t("确认")}</button>
                    <button type="button" onClick={() => setConfirmRemoveId(null)} className="text-sm text-gray-500 hover:underline">{t("取消")}</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmRemoveId(card.id)} className="text-sm text-red-600 hover:underline">{t("解绑")}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 绑卡表单（内联展开） */}
      {showAddForm && (
        <div className="mt-4 p-4 rounded-lg border border-gray-200 bg-gray-50">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">{t("卡号")}</label>
              <input
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder={t("卡号")}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1">{t("有效期")}</label>
                <input
                  value={expiry}
                  onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                  placeholder="MM/YY"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1">{t("安全码")}</label>
                <input
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="CVC"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t("持卡人姓名")}</label>
              <input
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
                placeholder={t("持卡人姓名")}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            {/* validateCardInput 返回中文文案而非 i18n key，直接显示无需 t() */}
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => { resetForm(); setShowAddForm(false); }} className="px-4 py-2 text-sm text-gray-600 hover:underline">{t("取消")}</button>
              <button type="button" onClick={handleSaveCard} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700">{t("保存")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default SavedCardsSection;
