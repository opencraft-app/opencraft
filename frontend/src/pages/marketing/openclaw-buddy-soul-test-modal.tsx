import { ChevronLeft, RotateCcw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { getSoulSpec } from "@/lib/soul-interpretations";
import { SoulFaceCard } from "@/pages/marketing/openclaw-buddy-cards";
import {
  PREF_TAGS,
  calculateMatchedSoul,
  calculatePrefScores,
  categorizePrefScores,
  generatePersonalityProfile,
  isPersonalityQuestion,
  personalityQuestions,
  prefQuestions,
  shuffleArray,
  type PrefTag,
  type SoulTestQuestion,
} from "@/pages/marketing/openclaw-buddy-soul-test-data";

type Phase = "testing" | "result";

interface SoulTestModalProps {
  open: boolean;
  souls: SkillHubSoul[];
  maxDrawsReached: boolean;
  drawnSlugs: string[];
  saveDisabledReason?: string | null;
  onClose: () => void;
  onUseSoul: (soul: SkillHubSoul) => boolean;
}

export function SoulTestModal({
  open,
  souls,
  maxDrawsReached,
  drawnSlugs,
  saveDisabledReason,
  onClose,
  onUseSoul,
}: SoulTestModalProps) {
  const t = useT();
  const autoAdvanceTimer = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("testing");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [matchedSoulId, setMatchedSoulId] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<SoulTestQuestion[]>(() => buildQuestions());

  useEffect(() => {
    if (!open) return;
    setPhase("testing");
    setCurrentIndex(0);
    setAnswers({});
    setMatchedSoulId(null);
    setUseError(null);
    setQuestions(buildQuestions());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      if (autoAdvanceTimer.current) window.clearTimeout(autoAdvanceTimer.current);
    };
  }, [open]);

  const currentQuestion = questions[currentIndex];
  const totalQuestions = questions.length;
  const recommendedSoul = useMemo(
    () => souls.find((soul) => soul.slug === matchedSoulId) ?? null,
    [matchedSoulId, souls],
  );
  const spec = matchedSoulId ? getSoulSpec(matchedSoulId) : null;
  const prefScores = useMemo(() => calculatePrefScores(answers), [answers]);
  const prefCategories = useMemo(() => categorizePrefScores(prefScores), [prefScores]);
  const topTags = useMemo(() => {
    return PREF_TAGS
      .filter((tag) => prefScores[tag] > 0)
      .sort((left, right) => prefScores[right] - prefScores[left])
      .slice(0, 4);
  }, [prefScores]);
  const profileText = useMemo(() => generatePersonalityProfile(answers), [answers]);

  const handleSelect = useCallback(
    (key: string) => {
      if (!currentQuestion) return;
      setUseError(null);
      const nextAnswers = { ...answers, [currentQuestion.id]: key };
      setAnswers(nextAnswers);

      if (autoAdvanceTimer.current) {
        window.clearTimeout(autoAdvanceTimer.current);
      }

      autoAdvanceTimer.current = window.setTimeout(() => {
        if (currentIndex < totalQuestions - 1) {
          setCurrentIndex((prev) => prev + 1);
          return;
        }
        setMatchedSoulId(calculateMatchedSoul(nextAnswers));
        setPhase("result");
      }, 300);
    },
    [answers, currentIndex, currentQuestion, totalQuestions],
  );

  const handlePrev = useCallback(() => {
    if (autoAdvanceTimer.current) {
      window.clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleRetry = useCallback(() => {
    if (autoAdvanceTimer.current) {
      window.clearTimeout(autoAdvanceTimer.current);
      autoAdvanceTimer.current = null;
    }
    setPhase("testing");
    setCurrentIndex(0);
    setAnswers({});
    setMatchedSoulId(null);
    setUseError(null);
    setQuestions(buildQuestions());
  }, []);

  const handleUseSoul = useCallback(() => {
    if (!recommendedSoul) return;
    if (saveDisabledReason) {
      setUseError(saveDisabledReason);
      return;
    }
    if (maxDrawsReached && !drawnSlugs.includes(recommendedSoul.slug)) {
      setUseError(t("卡槽已满，请先删除一张人设，再使用测试推荐"));
      return;
    }
    const accepted = onUseSoul(recommendedSoul);
    if (accepted) onClose();
  }, [drawnSlugs, maxDrawsReached, onClose, onUseSoul, recommendedSoul, saveDisabledReason, t]);

  if (!open) return null;

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t("Soul人格测试")}
          className="relative flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_28px_80px_rgba(0,0,0,0.22)]"
          initial={{ y: 18, scale: 0.98, opacity: 0 }}
          animate={{ y: 0, scale: 1, opacity: 1 }}
          exit={{ y: 18, scale: 0.98, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 24 }}
        >
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-32"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,166,0,0.30) 0%, rgba(255,214,116,0.18) 42%, rgba(255,255,255,0) 100%)",
            }}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("关闭 Soul人格测试")}
            className="absolute right-5 top-5 z-10 rounded-full p-2 text-black/45 transition-colors hover:bg-black/5 hover:text-black"
          >
            <X className="h-5 w-5" />
          </button>

          {phase === "testing" && currentQuestion ? (
            <QuestionStep
              question={currentQuestion}
              index={currentIndex + 1}
              total={totalQuestions}
              selectedKey={answers[currentQuestion.id] ?? null}
              onSelect={handleSelect}
              onPrev={handlePrev}
              canGoPrev={currentIndex > 0}
            />
          ) : (
            <ResultStep
              matchedSoulId={matchedSoulId}
              soul={recommendedSoul}
              specText={spec?.interpretation ?? null}
              profileText={profileText}
              topTags={topTags}
              prefCategories={prefCategories}
              useError={useError}
              onUseSoul={handleUseSoul}
              onRetry={handleRetry}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

function QuestionStep({
  question,
  index,
  total,
  selectedKey,
  onSelect,
  onPrev,
  canGoPrev,
}: {
  question: SoulTestQuestion;
  index: number;
  total: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onPrev: () => void;
  canGoPrev: boolean;
}) {
  const t = useT();
  const isPersonality = isPersonalityQuestion(question);
  const progress = (index / total) * 100;

  return (
    <div className="relative flex min-h-[620px] flex-col overflow-y-auto px-7 pb-7 pt-8 sm:px-10">
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 py-1 text-xs font-medium text-black/55">
          <Sparkles className="h-3.5 w-3.5 text-[#FFA600]" />
          {t("Soul人格测试")}
        </div>
        <h3 className="text-2xl font-semibold tracking-normal text-black/90">
          {isPersonality ? t("先来了解你的灵魂画像") : t("选择你对 AI 搭子的偏好")}
        </h3>
      </div>

      <div className="mx-auto w-full max-w-[620px]">
        <div className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={onPrev}
              disabled={!canGoPrev}
              className={cn(
                "inline-flex items-center gap-1 text-sm transition-colors",
                canGoPrev
                  ? "cursor-pointer text-black/55 hover:text-black"
                  : "cursor-not-allowed text-black/20",
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              {t("上一题")}
            </button>
            <span className="text-sm text-black/50">
              {index} / {total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/5">
            <div
              className="h-full rounded-full bg-black transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-black/8 bg-white p-6 shadow-[0_16px_40px_rgba(0,0,0,0.04)] sm:p-8">
          <h4 className="mb-7 text-lg font-medium leading-relaxed text-black/90">
            {t(question.text)}
          </h4>
          <div className="flex flex-col gap-3">
            {question.options.map((option) => {
              const isSelected = selectedKey === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => onSelect(option.key)}
                  className={cn(
                    "w-full rounded-[10px] border px-5 py-4 text-left text-[15px] leading-relaxed transition-all duration-200",
                    isSelected
                      ? "border-black bg-black text-white shadow-[0_10px_26px_rgba(0,0,0,0.16)]"
                      : "border-black/8 bg-white text-black/70 hover:border-black/18 hover:bg-black/[0.03]",
                  )}
                >
                  <span className="mr-2 font-semibold">{option.key}.</span>
                  {t(option.text)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultStep({
  matchedSoulId,
  soul,
  specText,
  profileText,
  topTags,
  prefCategories,
  useError,
  onUseSoul,
  onRetry,
}: {
  matchedSoulId: string | null;
  soul: SkillHubSoul | null;
  specText: string | null;
  profileText: string;
  topTags: PrefTag[];
  prefCategories: Record<PrefTag, "high" | "mid" | "low">;
  useError: string | null;
  onUseSoul: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const interpretation = specText?.split("\n")[0] ?? "";

  return (
    <div className="relative max-h-[88vh] overflow-y-auto px-7 pb-7 pt-8 sm:px-10">
      <div className="mb-6 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 py-1 text-xs font-medium text-black/55">
          <Sparkles className="h-3.5 w-3.5 text-[#FFA600]" />
          {t("测试完成")}
        </div>
        <h3 className="text-2xl font-semibold tracking-normal text-black/90">
          {t("为你推荐的 Soul 是")}
        </h3>
      </div>

      {soul ? (
        <div className="grid gap-7 lg:grid-cols-[260px_1fr]">
          <div className="flex justify-center">
            <SoulFaceCard soul={soul} size="large" />
          </div>
          <div className="space-y-4">
            <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)]">
              <p className="mb-1 text-xs font-medium text-black/45">{t("匹配结果")}</p>
              <h4 className="mb-2 text-2xl font-semibold text-black/90">{soul.displayName}</h4>
              <p className="text-sm leading-relaxed text-black/62">{soul.summary}</p>
            </section>

            {profileText && (
              <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)]">
                <h4 className="mb-2 text-sm font-semibold text-black/85">{t("你的灵魂画像")}</h4>
                <p className="text-sm leading-relaxed text-black/62">{t(profileText)}</p>
              </section>
            )}

            <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)]">
              <h4 className="mb-3 text-sm font-semibold text-black/85">{t("推荐原因")}</h4>
              <div className="mb-3 flex flex-wrap gap-2">
                {(topTags.length > 0 ? topTags : PREF_TAGS.slice(0, 3)).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-black/8 bg-black/[0.03] px-3 py-1 text-xs font-medium text-black/62"
                  >
                    {t(tag)} · {t(categoryLabel(prefCategories[tag]))}
                  </span>
                ))}
              </div>
              <p className="text-sm leading-relaxed text-black/55">
                {t("系统根据你的 10 道偏好题计算 8 维偏好分数，并与 16 张 Soul 的权重做相似度匹配。")}
              </p>
            </section>

            {interpretation && (
              <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)]">
                <h4 className="mb-2 text-sm font-semibold text-black/85">{t("Soul设定解读")}</h4>
                <p className="line-clamp-4 text-sm leading-relaxed text-black/62">{t(interpretation)}</p>
              </section>
            )}
          </div>
        </div>
      ) : (
        <div className="py-16 text-center text-sm text-black/55">
          {matchedSoulId
            ? t("暂未加载到推荐卡片，请稍后重试")
            : t("未找到匹配结果，请重新测试")}
        </div>
      )}

      {useError && (
        <p className="mt-5 text-center text-sm font-medium text-red-600">{useError}</p>
      )}

      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onUseSoul();
          }}
          disabled={!soul}
          className="inline-flex h-[50px] min-w-[168px] items-center justify-center rounded-full bg-black px-8 text-sm font-medium text-white shadow-[0_12px_28px_rgba(0,0,0,0.16)] transition-all hover:-translate-y-0.5 hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {t("使用该 Soul")}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-[50px] items-center justify-center gap-2 rounded-full border border-black/8 bg-white px-8 text-sm font-medium text-black/70 transition-all hover:-translate-y-0.5 hover:bg-black/[0.03]"
        >
          <RotateCcw className="h-4 w-4" />
          {t("重新测试")}
        </button>
      </div>
    </div>
  );
}

function buildQuestions(): SoulTestQuestion[] {
  return [...shuffleArray(personalityQuestions), ...shuffleArray(prefQuestions)];
}

function categoryLabel(category: "high" | "mid" | "low"): string {
  if (category === "high") return "高";
  if (category === "mid") return "中";
  return "低";
}
