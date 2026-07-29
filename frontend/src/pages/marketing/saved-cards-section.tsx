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

// 占位导出，Task 2 会替换为真实组件
export const _SavedCardsSectionPlaceholder = () => {
  void useT();
  return null;
};
