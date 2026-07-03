/**
 * Support / LightVela Product Feedback — 用户端问卷表单页面
 * ──────────────────────────────────────────────────────────────
 * 对照中文问卷内容 1:1 做英文国际站版本。
 */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { LegalFooter } from '@/components/site/legal-footer';
import type { LanguageSwitcherVariant } from '@/components/site/language-switcher';
import { LoginModal } from '@/components/site/login-modal';
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from '@/components/site/public-site-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DisplayTitle } from '@/components/ui/display-title';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/contexts/session-context';
import { useT } from '@/i18n/t';
import { isGlobal } from '@/lib/region';
import { cn } from '@/lib/utils';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

/* ──────────────────────────────────────────────────────────
 * 类型
 * ────────────────────────────────────────────────────────── */

type FeedbackType =
  | 'experience_issue'
  | 'bug_report'
  | 'feature_request'
  | 'rant'
  | 'performance'
  | 'billing'
  | 'security'
  | 'docs'
  | 'compliment'
  | 'other';

interface UploadedFile {
  name: string;
  size: number;
  url: string; // object URL for preview
  file: File;
}

interface SupportFeedbackDraft {
  feedbackType: FeedbackType | '';
  otherText: string;
  description: string;
  contactInfo: string;
}

const SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY = 'lightvela-support-feedback-draft-v1';

function isFeedbackType(value: unknown): value is FeedbackType {
  return value === 'experience_issue'
    || value === 'bug_report'
    || value === 'feature_request'
    || value === 'rant'
    || value === 'performance'
    || value === 'billing'
    || value === 'security'
    || value === 'docs'
    || value === 'compliment'
    || value === 'other';
}

function readSupportFeedbackDraft(): SupportFeedbackDraft | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SupportFeedbackDraft>;
    return {
      feedbackType: isFeedbackType(parsed.feedbackType) ? parsed.feedbackType : '',
      otherText: typeof parsed.otherText === 'string' ? parsed.otherText : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      contactInfo: typeof parsed.contactInfo === 'string' ? parsed.contactInfo : '',
    };
  } catch {
    return null;
  }
}

function writeSupportFeedbackDraft(draft: SupportFeedbackDraft): void {
  if (typeof window === 'undefined') {
    return;
  }
  const hasContent = Boolean(draft.feedbackType || draft.otherText.trim() || draft.description.trim());
  if (!hasContent) {
    window.sessionStorage.removeItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
    return;
  }
  window.sessionStorage.setItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

function clearSupportFeedbackDraft(): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(SUPPORT_FEEDBACK_DRAFT_STORAGE_KEY);
  }
}

/* ──────────────────────────────────────────────────────────
 * 主组件
 * ────────────────────────────────────────────────────────── */

type SupportPageProps = {
  authControls?: ReactNode;
  currentPath?: string;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};


export function SupportPage({
  authControls,
  currentPath,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: SupportPageProps = {}): React.ReactElement {
  const t = useT();
  const { i18n } = useTranslation();
  const { session, authReady, isAuthenticated } = useSession();
  const userId = session.user?.id?.trim() ?? '';
  const isEnglish = isGlobal && !i18n.language.startsWith('zh');
  const activePublicLocale: PublicSiteLocale = isGlobal
    ? (isEnglish ? 'en-US' : 'zh-SG')
    : 'zh-CN';
  const pageCopy = {
    pageTitle: isEnglish ? 'Product Feedback' : t('产品反馈'),
    pageDesc: isEnglish
      ? 'Share your experience, report bugs, or suggest features to help us improve LightVela.'
      : t('您可以将使用 LightVela 过程中的任何体验问题或需求建议告诉我们，帮助我们变得更好！'),
    testModeTitle: isEnglish ? 'Test mode' : '测试模式',
    testModeBanner: isEnglish
      ? 'Login checks are temporarily disabled so the form can be submitted directly during local testing. Switch `authRequired` back to `true` before release.'
      : '登录校验已临时关闭，表单可直接填写提交。上线前需将 authRequired 改回 true。',
    devAccountPlaceholder: isEnglish
      ? 'Enter any account ID (e.g. usr_test_xxx); test mode allows manual input'
      : '输入任意账号ID（如 usr_test_xxx），测试模式可自填',
    devAccountHint: isEnglish ? 'Test mode: you can submit directly without logging in' : '测试模式：直接填写即可，不需要登录',
    contactHintPrimary: isEnglish
      ? 'Leave a phone number or email if you’d like a follow-up.'
      : '可留下手机号或邮箱；',
    contactHintExamples: isEnglish
      ? 'Phone example: +86 133xxxx8888, email example: 1234@gmail.com.'
      : '手机号如：+86 133xxxx8888，邮箱如：1234@gmail.com',
  };

  // ── DEV TEST MODE ──────────────────────────────────────────
  // 临时旁路登录，方便在本地直接填写表单测试完整提交流程。
  // 生产上线前需删除此段（恢复 authRequired = true）。
  const authRequired = false;
  const [devAccountId, setDevAccountId] = useState('');
  const effectiveUserId = authRequired ? userId : (userId || devAccountId.trim());
  // ───────────────────────────────────────────────────────────

  /* Form state */
  const [feedbackType, setFeedbackType] = useState<FeedbackType | ''>('');
  const [otherText, setOtherText] = useState('');
  const [description, setDescription] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [hasRestoredDraft, setHasRestoredDraft] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const draft = readSupportFeedbackDraft();
    if (draft) {
      setFeedbackType(draft.feedbackType);
      setOtherText(draft.otherText);
      setDescription(draft.description);
      setContactInfo(draft.contactInfo);
    }
    setHasRestoredDraft(true);
  }, []);

  useEffect(() => {
    if (!hasRestoredDraft || submitted) {
      return;
    }
    writeSupportFeedbackDraft({ feedbackType, otherText, description, contactInfo });
  }, [contactInfo, description, feedbackType, hasRestoredDraft, otherText, submitted]);

  useEffect(() => {
    if (!userId) {
      return;
    }
    setErrors((prev) => {
      if (!prev.accountId) {
        return prev;
      }
      const next = { ...prev };
      delete next.accountId;
      return next;
    });
  }, [userId]);

  const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB

  const feedbackOptions: { value: FeedbackType; label: string }[] = [
    { value: 'experience_issue', label: t('体验问题反馈') },
    { value: 'bug_report', label: t('Bug 反馈') },
    { value: 'feature_request', label: t('产品功能建议') },
    { value: 'performance', label: t('性能 / 卡顿问题') },
    { value: 'billing', label: t('账单 / 计费问题') },
    { value: 'security', label: t('安全 / 隐私问题') },
    { value: 'docs', label: t('文档 / 帮助问题') },
    { value: 'compliment', label: t('产品表扬') },
    { value: 'rant', label: t('产品吐槽') },
    { value: 'other', label: t('其他') },
  ];

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!effectiveUserId) {
      errs.accountId = authRequired ? t('请先登录后再提交反馈') : t('请填写账号ID（测试模式）');
    }
    if (!feedbackType) {
      errs.feedbackType = t('请选择反馈类型');
    }
    if (feedbackType === 'other' && !otherText.trim()) {
      errs.otherText = t('请填写具体类型');
    }
    if (!description.trim()) {
      errs.description = t('请填写反馈内容');
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const clearFiles = () => {
    setFiles((prev) => {
      for (const uploaded of prev) {
        URL.revokeObjectURL(uploaded.url);
      }
      return [];
    });
  };

  const openLoginModal = () => {
    setShowLoginModal(true);
  };

  const submitFeedback = async () => {
    setIsSubmitting(true);
    try {
      const { createSupportFeedback, isSupportCosConfigured } = await import(
        '@/lib/support-feedback-cos-client'
      );
      if (!isSupportCosConfigured()) {
        throw new Error(t('反馈系统未配置，请稍后再试'));
      }
      await createSupportFeedback({
        accountId: effectiveUserId,
        feedbackType,
        otherText: otherText.trim() || null,
        description: description.trim(),
        files: files.map((uploaded) => uploaded.file),
        contactInfo: contactInfo.trim() || null,
      });
      clearSupportFeedbackDraft();
      clearFiles();
      setErrors({});
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('提交失败，请稍后重试'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError('');

    if (!authReady) {
      return;
    }
    if (authRequired && (!isAuthenticated || !userId)) {
      setErrors((prev) => ({ ...prev, accountId: t('请先登录后再提交反馈') }));
      openLoginModal();
      return;
    }
    if (!validate()) {
      return;
    }

    await submitFeedback();
  };

  const handleReset = () => {
    clearSupportFeedbackDraft();
    setFeedbackType('');
    setOtherText('');
    setDescription('');
    setContactInfo('');
    clearFiles();
    setSubmitted(false);
    setIsSubmitting(false);
    setSubmitError('');
    setErrors({});
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles: UploadedFile[] = [];
    for (let i = 0; i < selected.length; i++) {
      const f = selected[i];
      if (f.size > MAX_FILE_SIZE) continue; // skip oversized
      newFiles.push({
        name: f.name,
        size: f.size,
        url: URL.createObjectURL(f),
        file: f,
      });
    }
    setFiles((prev) => [...prev, ...newFiles]);
    // reset input so same file can be re-selected
    e.target.value = '';
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => {
      const removed = prev[idx];
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleUploadTrigger = () => {
    if (authRequired && (!isAuthenticated || !userId)) {
      setErrors((prev) => ({ ...prev, accountId: t('请先登录后再上传附件') }));
      openLoginModal();
      return;
    }
    fileInputRef.current?.click();
  };

  return (
    <div
      className="landing-page lw-setup-bg relative flex min-h-screen flex-col overflow-hidden"
      style={{ color: 'var(--lw-fg)' }}
    >
      <PublicSiteHeader
        authControls={authControls}
        currentPath={currentPath}
        currentSection=""
        locale={activePublicLocale}
        localized={publicLocalized}
        position="fixed"
        renderLink={renderLink}
        renderLanguageSwitcher={renderLanguageSwitcher}
      />

      <main className="relative z-10 flex-grow pt-[60px]">
        <div className="mx-auto max-w-3xl px-6 py-16">
          {submitted ? (
            /* ── 提交成功 ── */
            <Card className="p-10 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success)]/10">
                <svg className="h-8 w-8 text-[var(--color-success)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <DisplayTitle as="h2" size="section" className="mb-2">
                {t('提交成功')}
              </DisplayTitle>
              <p className="mb-6 text-sm text-[var(--text-secondary)]">
                {t('感谢您的反馈！我们已收到您的问题，会尽快处理。')}
              </p>
              <Button type="button" onClick={handleReset}>
                {t('继续反馈')}
              </Button>
            </Card>
          ) : (
            /* ── 问卷表单 ── */
            <Card>
              <CardContent className="space-y-10 pt-6">
                <form onSubmit={handleSubmit} className="space-y-10">
                  {/* 标题 */}
                  <div className="text-center">
                    <DisplayTitle as="h1" size="page">
                      {pageCopy.pageTitle}
                    </DisplayTitle>
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">
                      {pageCopy.pageDesc}
                    </p>
                  </div>

              {/* DEV TEST BANNER */}
              {!authRequired && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  ⚠️ <strong>{pageCopy.testModeTitle}</strong>：{pageCopy.testModeBanner}
                </div>
              )}

              {/* 01 账号 ID */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="text-red-500">*</span>
                  <span className="font-semibold text-[var(--text-tertiary)]">01</span>
                  {t('您的账号ID是？')}
                </Label>
                {isAuthenticated && userId ? (
                  <>
                    <Input
                      type="text"
                      value={userId}
                      readOnly
                      className={cn(
                        'bg-[var(--surface-muted)] text-[var(--text-tertiary)]',
                        errors.accountId && 'border-red-400 focus-visible:ring-red-400/20',
                      )}
                    />
                    <p className="text-xs text-[var(--text-tertiary)]">
                      {t('已自动读取当前登录账号ID；如需更换账号，请先切换登录身份后再提交。')}
                    </p>
                  </>
                ) : !authRequired ? (
                  <>
                    <Input
                      type="text"
                      value={devAccountId}
                      onChange={(e) => setDevAccountId(e.target.value)}
                      placeholder={pageCopy.devAccountPlaceholder}
                      className={cn(errors.accountId && 'border-red-400 focus-visible:ring-red-400/20')}
                    />
                    <p className="text-xs text-amber-700">{pageCopy.devAccountHint}</p>
                  </>
                ) : (
                  <div
                    className={cn(
                      'rounded-md border border-[var(--border-strong)] bg-white/90 p-4',
                      errors.accountId && 'border-red-400',
                    )}
                  >
                    <p className="text-sm text-[var(--text-secondary)]">
                      {t('登录后系统会自动读取您的账号ID，并在完成登录后返回当前页面继续提交。')}
                    </p>
                    <p className="mt-2 text-xs text-[var(--text-tertiary)]">
                      {t('您已填写的类型和问题描述会保留；为避免附件丢失，请登录后再上传文件。')}
                    </p>
                    <div className="mt-4">
                      <Button type="button" variant="outline" onClick={openLoginModal}>
                        {t('登录后继续')}
                      </Button>
                    </div>
                  </div>
                )}
                {errors.accountId && (
                  <p className="text-xs text-red-500">{errors.accountId}</p>
                )}
              </div>

              {/* 02 反馈类型 */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="text-red-500">*</span>
                  <span className="font-semibold text-[var(--text-tertiary)]">02</span>
                  {t('您本次提交的类型具体是？')}
                </Label>
                <Select
                  value={feedbackType || undefined}
                  onValueChange={(value) => {
                    const nextValue = value as FeedbackType;
                    setFeedbackType(nextValue);
                    if (nextValue !== 'other') {
                      setOtherText('');
                    }
                  }}
                >
                  <SelectTrigger
                    aria-invalid={errors.feedbackType ? 'true' : 'false'}
                    className={cn(errors.feedbackType && 'border-red-400 focus-visible:ring-red-400/20')}
                  >
                    <SelectValue placeholder={t('请选择本次提交类型')} />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {feedbackOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {feedbackType === 'other' && (
                  <Input
                    type="text"
                    value={otherText}
                    onChange={(e) => setOtherText(e.target.value)}
                    placeholder={t('请填写具体类型')}
                    className={errors.otherText ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                  />
                )}
                {errors.feedbackType && (
                  <p className="text-xs text-red-500">{errors.feedbackType}</p>
                )}
                {errors.otherText && (
                  <p className="text-xs text-red-500">{errors.otherText}</p>
                )}
              </div>

              {/* 03 具体反馈内容 */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <span className="text-red-500">*</span>
                  <span className="font-semibold text-[var(--text-tertiary)]">03</span>
                  {t('您具体希望反馈的问题或建议是？')}
                </Label>
                <p className="text-xs text-[var(--text-tertiary)]">
                  {t('您可以在此填写详细说明')}
                </p>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  placeholder={t('请输入')}
                  className={errors.description ? 'border-red-400 focus-visible:ring-red-400/20' : ''}
                />
                {errors.description && (
                  <p className="text-xs text-red-500">{errors.description}</p>
                )}
              </div>

              {/* 04 联系方式（可选） */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="font-semibold text-[var(--text-tertiary)]">04</span>
                  {t('您的联系方式（选填）')}
                </Label>
                <div className="space-y-1 text-xs text-[var(--text-tertiary)]">
                  <p>{pageCopy.contactHintPrimary}</p>
                  <p>{pageCopy.contactHintExamples}</p>
                </div>
                <Input
                  type="text"
                  value={contactInfo}
                  onChange={(e) => setContactInfo(e.target.value)}
                  placeholder={t('手机号 / 邮箱（选填）')}
                />
              </div>

              {/* 05 文件上传 */}
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <span className="font-semibold text-[var(--text-tertiary)]">05</span>
                  {t('如您有需要上传的图片或文件，可添加至此处')}
                </Label>
                <div
                  className={cn(
                    'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 transition-colors',
                    isAuthenticated && userId
                      ? 'cursor-pointer border-[var(--border-strong)] bg-white hover:border-[var(--text-primary)]/30 hover:bg-[var(--surface-muted)]'
                      : 'cursor-pointer border-[var(--border-strong)] bg-[var(--surface-muted)]/70',
                  )}
                  onClick={handleUploadTrigger}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleUploadTrigger();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border-strong)] bg-white text-[var(--text-primary)]">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {(isAuthenticated && userId) || !authRequired
                      ? t('点击上传或拖拽图片/文件至此处')
                      : t('请先登录，登录后可上传图片或文件')}
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  disabled={authRequired && !isAuthenticated && !userId}
                  className="hidden"
                  onChange={handleFileChange}
                />
                <p className="text-xs text-[var(--text-tertiary)]">
                  ⓘ {isAuthenticated && userId
                    ? t('单个图片/文件大小不超过300MB')
                    : t('登录跳转会刷新页面，为避免文件丢失，请先登录后再上传附件')}
                </p>

                {/* 已上传文件列表 */}
                {files.length > 0 && (
                  <ul className="space-y-2">
                    {files.map((f, i) => (
                      <li
                        key={f.name + i}
                        className="flex items-center justify-between rounded-xl bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]"
                      >
                        <span className="truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          className="ml-2 text-red-500 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 提交按钮 */}
              <div className="flex flex-col items-center gap-3 pt-4">
                {submitError && (
                  <p className="text-sm text-red-500">{submitError}</p>
                )}
                <Button type="submit" disabled={isSubmitting} size="lg" className="px-12">
                  {isSubmitting
                    ? t('提交中...')
                    : (isAuthenticated && userId) || !authRequired
                      ? t('提交')
                      : !authReady
                        ? t('正在读取登录状态...')
                        : t('登录后提交')}
                </Button>
              </div>
            </form>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <LegalFooter />
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onSuccess={() => {
          setShowLoginModal(false);
          setSubmitError('');
        }}
      />
    </div>
  );
}
 