const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** created_time 起算的已服务天数；至少显示 1 天（当天订阅不该显示 0） */
export const computeServedDays = (createdTime: string | undefined, now = Date.now()): number | null => {
  if (!createdTime) return null;
  const start = new Date(createdTime).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(1, Math.floor((now - start) / MS_PER_DAY) + 1);
};

/** 有效期至（本地化日期串） */
export const formatExpiryDate = (expiredTime: string | undefined, locale = "zh-CN"): string | null => {
  if (!expiredTime) return null;
  const end = new Date(expiredTime);
  if (Number.isNaN(end.getTime())) return null;
  return end.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
};
