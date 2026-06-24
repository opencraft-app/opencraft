import { ChevronDown, ChevronLeft, ChevronUp, RotateCcw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useT } from "@/i18n/t";
import { SoulSpecPanel } from "@/components/soul-spec-panel";
import { cn } from "@/lib/utils";
import type { SkillHubSoul } from "@/lib/skillhub-api";
import { getSoulSpec, type SoulSpec } from "@/lib/soul-interpretations";
import { getEnglishSoulSpec } from "@/lib/soul-english-data";
import { SoulFaceCard } from "@/pages/marketing/openclaw-buddy-cards";
import {
  ENGLISH_PREF_TAG_LABELS,
  buildEnglishQuestions,
  calculateEnglishMatchedSoul,
  calculateEnglishPrefScores,
  categorizeEnglishPrefScores,
  generateEnglishPersonalityProfile,
} from "@/pages/marketing/openclaw-buddy-soul-test-data.en";
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
  useEnglishSoulData?: boolean;
  onClose: () => void;
  onUseSoul: (soul: SkillHubSoul) => boolean;
}

export function SoulTestModal({
  open,
  souls,
  maxDrawsReached,
  drawnSlugs,
  saveDisabledReason,
  useEnglishSoulData = false,
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
  const [questions, setQuestions] = useState<SoulTestQuestion[]>(() => buildQuestions(useEnglishSoulData));

  useEffect(() => {
    if (!open) return;
    setPhase("testing");
    setCurrentIndex(0);
    setAnswers({});
    setMatchedSoulId(null);
    setUseError(null);
    setQuestions(buildQuestions(useEnglishSoulData));
  }, [open, useEnglishSoulData]);

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
  const spec = matchedSoulId ? getLocalizedSoulSpec(matchedSoulId, useEnglishSoulData) : null;
  const prefScores = useMemo(
    () => useEnglishSoulData ? calculateEnglishPrefScores(answers) : calculatePrefScores(answers),
    [answers, useEnglishSoulData],
  );
  const prefCategories = useMemo(
    () => useEnglishSoulData ? categorizeEnglishPrefScores(prefScores) : categorizePrefScores(prefScores),
    [prefScores, useEnglishSoulData],
  );
  const profileText = useMemo(
    () => useEnglishSoulData ? generateEnglishPersonalityProfile(answers) : generatePersonalityProfile(answers),
    [answers, useEnglishSoulData],
  );

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
        setMatchedSoulId(useEnglishSoulData ? calculateEnglishMatchedSoul(nextAnswers) : calculateMatchedSoul(nextAnswers));
        setPhase("result");
      }, 300);
    },
    [answers, currentIndex, currentQuestion, totalQuestions, useEnglishSoulData],
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
    setQuestions(buildQuestions(useEnglishSoulData));
  }, [useEnglishSoulData]);

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
              useEnglishSoulData={useEnglishSoulData}
            />
          ) : (
            <ResultStep
              matchedSoulId={matchedSoulId}
              soul={recommendedSoul}
              spec={spec}
              profileText={profileText}
              prefCategories={prefCategories}
              useError={useError}
              onUseSoul={handleUseSoul}
              onRetry={handleRetry}
              useEnglishSoulData={useEnglishSoulData}
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
  useEnglishSoulData,
}: {
  question: SoulTestQuestion;
  index: number;
  total: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onPrev: () => void;
  canGoPrev: boolean;
  useEnglishSoulData: boolean;
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
          {isPersonality
            ? t("第一部分：了解你的灵魂画像")
            : t("第二部分：选择你对智能体伙伴的偏好")}
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

        <div className="flex flex-col gap-4 rounded-2xl border border-black/8 bg-white p-6 shadow-[0_16px_40px_rgba(0,0,0,0.04)] sm:p-8">
          <h4 className="text-lg font-medium leading-relaxed text-black/90">
            {formatSoulTestText(question.text, t, useEnglishSoulData)}
          </h4>
          <div className="flex flex-col gap-3">
            {question.options.map((option) => {
              const isSelected = selectedKey === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => onSelect(option.key)}
                  style={{ fontSize: "14px" }}
                  className={cn(
                    "w-full rounded-[10px] border px-5 py-4 text-left text-lg leading-relaxed transition-all duration-200",
                    isSelected
                      ? "border-black bg-black text-white shadow-[0_10px_26px_rgba(0,0,0,0.16)]"
                      : "border-black/8 bg-white text-black/70 hover:border-black/18 hover:bg-black/[0.03]",
                  )}
                >
                  <span className="mr-2 font-semibold">{option.key}.</span>
                  {formatSoulTestText(option.text, t, useEnglishSoulData)}
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
  spec,
  profileText,
  prefCategories,
  useError,
  onUseSoul,
  onRetry,
  useEnglishSoulData,
}: {
  matchedSoulId: string | null;
  soul: SkillHubSoul | null;
  spec: SoulSpec | null;
  profileText: string;
  prefCategories: Record<PrefTag, "high" | "mid" | "low">;
  useError: string | null;
  onUseSoul: () => void;
  onRetry: () => void;
  useEnglishSoulData: boolean;
}) {
  const t = useT();
  const [soulInfoOpen, setSoulInfoOpen] = useState(false);

  useEffect(() => {
    setSoulInfoOpen(false);
  }, [soul?.slug]);

  return (
    <div className="relative max-h-[88vh] overflow-y-auto px-7 pb-7 pt-8 sm:px-10">
      <div className="mb-6 text-center">
        <h3 className="text-2xl font-semibold tracking-normal text-black/90">
          {t("为你推荐的智能体伙伴 Soul 是")}
        </h3>
      </div>

      {soul ? (
        <div className="flex flex-col gap-7">
          <div className="flex justify-center">
            <SoulFaceCard soul={soul} size="large" />
          </div>
          <div className="mx-auto w-full max-w-[680px] space-y-4">
            {spec && (
              <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)]">
                <h4 className="text-sm font-semibold text-black/85">{t("Soul 设定解读")}</h4>
                <div aria-hidden="true" style={{ height: "12px" }} />
                {soulInfoOpen ? (
                  <SoulSpecPanel spec={spec} />
                ) : (
                  <SoulInterpretationSummary interpretation={spec.interpretation} useEnglishSoulData={useEnglishSoulData} />
                )}
                <button
                  type="button"
                  onClick={() => setSoulInfoOpen((open) => !open)}
                  className="mt-4 inline-flex items-center gap-1.5 font-medium text-blue-600 transition-colors hover:text-blue-700"
                  style={{ fontSize: "14px" }}
                >
                  {soulInfoOpen ? t("收起 Soul 详情") : t("查看 Soul 详情")}
                  {soulInfoOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </section>
            )}

            <section className="rounded-2xl border border-black/8 bg-white p-5 shadow-[0_16px_40px_rgba(0,0,0,0.04)] sm:p-6">
              <h4 className="text-xl font-semibold text-black/90">{t("推荐原因")}</h4>
              {profileText && (
                <div className="mt-7">
                  <h5 className="text-base font-semibold text-black/85">{t("你的灵魂画像")}</h5>
                  <div aria-hidden="true" style={{ height: "12px" }} />
                  <p className="rounded-2xl bg-black/[0.03] px-5 py-4 text-sm leading-relaxed text-black/62">
                    {formatSoulTestText(profileText, t, useEnglishSoulData)}
                  </p>
                </div>
              )}
              <div className="mt-4">
                <h5 className="text-base font-semibold text-black/85">{t("你对 Soul 的偏好")}</h5>
                <div aria-hidden="true" style={{ height: "12px" }} />
                <div className="flex flex-wrap gap-2 rounded-2xl bg-black/[0.03] px-5 py-4">
                  {PREF_TAGS.map((tag) => {
                    const category = prefCategories[tag];
                    return (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-2 rounded-full border border-black/8 bg-white px-3 py-1.5 text-sm font-medium text-black/68 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                      >
                        {getPrefTagLabel(tag, t, useEnglishSoulData)}
                        <span
                          className={cn(
                            "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
                            category === "high" && "bg-[#FFF0D9] text-[#FF8A00]",
                            category === "mid" && "bg-[#FFF7E8] text-[#FF9A00]",
                            category === "low" && "bg-black/[0.05] text-black/45",
                          )}
                        >
                          {categoryLabel(category, useEnglishSoulData)}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </section>
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
          style={{ fontSize: "16px" }}
          className="inline-flex h-12 min-w-40 items-center justify-center rounded-full bg-black px-7 font-semibold leading-none text-white shadow-[0_12px_28px_rgba(0,0,0,0.16)] transition-all hover:-translate-y-0.5 hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
        >
          {t("添加该人设")}
        </button>
        <button
          type="button"
          onClick={onRetry}
          style={{ fontSize: "16px" }}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-black/8 bg-white px-7 font-semibold leading-none text-black/70 transition-all hover:-translate-y-0.5 hover:bg-black/[0.03]"
        >
          <RotateCcw className="h-[18px] w-[18px]" />
          {t("重新测试")}
        </button>
      </div>
    </div>
  );
}

function buildQuestions(useEnglishSoulData: boolean): SoulTestQuestion[] {
  if (useEnglishSoulData) return buildEnglishQuestions();
  return [...shuffleArray(personalityQuestions), ...shuffleArray(prefQuestions)];
}

function SoulInterpretationSummary({
  interpretation,
  useEnglishSoulData,
}: {
  interpretation: string;
  useEnglishSoulData: boolean;
}) {
  const t = useT();
  const lastNewline = interpretation.lastIndexOf("\n");
  const body = lastNewline === -1 ? interpretation : interpretation.slice(0, lastNewline);
  const cta = lastNewline === -1 ? "" : interpretation.slice(lastNewline + 1);

  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed text-black/62">
      {formatSoulTestText(body, t, useEnglishSoulData)}
      {cta ? "\n" : ""}
      {cta && (
        <span className="font-semibold text-black/70">
          {formatSoulTestText(cta, t, useEnglishSoulData)}
        </span>
      )}
    </p>
  );
}

function categoryLabel(category: "high" | "mid" | "low", useEnglishSoulData: boolean): string {
  if (useEnglishSoulData) {
    if (category === "high") return "High";
    if (category === "mid") return "Mid";
    return "Low";
  }
  if (category === "high") return "高";
  if (category === "mid") return "中";
  return "低";
}

function getLocalizedSoulSpec(slug: string, useEnglishSoulData: boolean): SoulSpec | null {
  return useEnglishSoulData ? getEnglishSoulSpec(slug) : getSoulSpec(slug);
}

function formatSoulTestText(
  text: string,
  t: (zh: string, options?: Record<string, unknown>) => string,
  useEnglishSoulData: boolean,
): string {
  return useEnglishSoulData ? text : t(text);
}

function getPrefTagLabel(
  tag: PrefTag,
  t: (zh: string, options?: Record<string, unknown>) => string,
  useEnglishSoulData: boolean,
): string {
  return useEnglishSoulData ? ENGLISH_PREF_TAG_LABELS[tag] : t(tag);
}
