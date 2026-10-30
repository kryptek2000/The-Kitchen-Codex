import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Volume2,
  VolumeX,
  Timer,
  Play,
  Pause,
  RotateCcw,
  List,
  Sun,
  ChefHat,
  Award,
  Plus,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { ObsidianRecipe, ActiveTimer } from '../types';
import { scaleIngredientText } from '../utils/markdownParser';
import { playTimerChime } from '../utils/audioAlert';
import { stepTimerKey, findTimerByKey } from '../application/timers';
import { useVaultImage } from '../hooks/useVaultImage';
import { getRecipeImage } from '../utils/imageHelper';

interface CookingModeModalProps {
  recipe: ObsidianRecipe;
  servings: number;
  activeTimers: ActiveTimer[];
  onStartTimer: (recipeTitle: string, minutes: number, label: string, semanticKey?: string) => void;
  onToggleTimer: (id: string) => void;
  onDeleteTimer: (id: string) => void;
  onAddCustomTimer?: () => void;
  onClose: () => void;
}

function formatInline(text: string): React.ReactNode {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      return (
        <strong key={i} className="font-semibold text-[var(--text-primary,#F3F4F6)]">
          {m[1]}
        </strong>
      );
    }
    return part;
  });
}

export function CookingModeModal({
  recipe,
  servings,
  activeTimers,
  onStartTimer,
  onToggleTimer,
  onDeleteTimer,
  onAddCustomTimer,
  onClose,
}: CookingModeModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showIngredientsDrawer, setShowIngredientsDrawer] = useState(false);
  const [showTimerTray, setShowTimerTray] = useState(false);
  const ingredientsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const ingredientSheetRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Record<number, boolean>>({});
  const [isFinished, setIsFinished] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [wakeLockStatus, setWakeLockStatus] = useState<'idle' | 'active' | 'denied' | 'unsupported'>('idle');
  const [stepAnnouncement, setStepAnnouncement] = useState('');

  const totalSteps = recipe.instructions.length;
  const currentStep = recipe.instructions[currentStepIndex] || { text: 'Enjoy your meal!', stepNumber: 1 };
  const baseServings = recipe.servings || 4;
  const stepNumber = currentStep.stepNumber || currentStepIndex + 1;
  const stepKey = stepTimerKey(recipe.id, stepNumber);
  const stepTimer = stepTimerKey(recipe.id, stepNumber) ? findTimerByKey(activeTimers, stepKey) : undefined;

  const defaultImg = getRecipeImage(recipe);
  const reactiveVaultImage = useVaultImage(recipe.image, defaultImg);

  const rawImage = typeof recipe.image === 'string' ? recipe.image.trim() : '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawImage);
  const isUnsafeScheme = hasScheme && !/^(https?:|data:|blob:)/i.test(rawImage);

  const hasExplicitImage =
    !isUnsafeScheme && (
      Boolean(recipe.image) ||
      /!\[\[(?:[^\]]*\|)?[^\]]+\.(?:jpg|jpeg|png|webp|avif|gif|svg)\]\]/i.test(recipe.rawMarkdown || '') ||
      /!\[[^\]]*\]\([^\)]*\.(?:jpg|jpeg|png|webp|avif|gif|svg)\)/i.test(recipe.rawMarkdown || '')
    );

  const resolvedImageUrl = hasExplicitImage ? (reactiveVaultImage || defaultImg) : null;
  // Preserve the CodeQL security fix: only render directly-addressable,
  // safe image URLs. Vault-resolved blob URLs are also allowed.
  const isSafeImageUrl =
    typeof resolvedImageUrl === 'string' &&
    /^(https?:|data:|blob:)/i.test(resolvedImageUrl.trim());
  const imageUrl = isSafeImageUrl ? resolvedImageUrl.trim() : null;
  const showPhoto = hasExplicitImage && !!imageUrl;

  const previouslyFocused = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    previouslyFocused.current = (document.activeElement as HTMLElement) || null;
    const node = modalRef.current;
    if (node) {
      node.setAttribute('tabindex', '-1');
      try { node.focus(); } catch { /* ignore */ }
    }
    return () => {
      try {
        previouslyFocused.current?.focus?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Ingredient sheet: initial focus, focus containment, and restoration.
  useEffect(() => {
    if (!showIngredientsDrawer) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const sheet = ingredientSheetRef.current;
    if (sheet) {
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      (focusable[0] || sheet).focus();
    }
    return () => {
      try {
        (ingredientsTriggerRef.current || previousFocusRef.current)?.focus?.();
      } catch {
        /* ignore */
      }
    };
  }, [showIngredientsDrawer]);

  // Announce step changes to assistive technology and stop any in-flight speech.
  useEffect(() => {
    const plainStepText = String(currentStep.text || '').replace(/\*\*/g, '');
    const text = `Now reading step ${currentStepIndex + 1}: ${plainStepText}`;
    setStepAnnouncement(text);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setIsSpeaking(false);
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    };
  }, [currentStepIndex, totalSteps, currentStep.text]);

  useEffect(() => {
    let wakeLock: any = null;
    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) {
        setWakeLockStatus('unsupported');
        return;
      }
      try {
        wakeLock = await (navigator as any).wakeLock.request('screen');
        setWakeLockActive(true);
        setWakeLockStatus('active');
      } catch (err) {
        console.warn('Wake Lock error:', err);
        setWakeLockActive(false);
        setWakeLockStatus('denied');
      }
    }
    requestWakeLock();

    return () => {
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isInteractive =
        !!target &&
        (target.tagName === 'BUTTON' ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape') {
        if (showIngredientsDrawer) {
          setShowIngredientsDrawer(false);
          return;
        }
        onClose();
        return;
      }

      // Focus trap: keep Tab/Shift+Tab inside the dialog.
      if (e.key === 'Tab') {
        const root = modalRef.current;
        if (!root) return;
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // Recover if focus has escaped the dialog.
        if (!root.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }

      // Cooking shortcuts only when not interacting with a control.
      if (isInteractive) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        handleNextStep();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevStep();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentStepIndex, totalSteps, showIngredientsDrawer]);

  const handleNextStep = () => {
    setCompletedSteps((prev) => ({ ...prev, [currentStepIndex]: true }));
    if (currentStepIndex < totalSteps - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      setIsFinished(true);
      const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!prefersReducedMotion) {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 },
        });
      }
      playTimerChime();
    }
  };

  const handlePrevStep = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
      setIsFinished(false);
    }
  };

  const toggleSpeak = () => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    } else {
      const textToRead = `Step ${currentStepIndex + 1}. ${currentStep.text}`;
      const utterance = new SpeechSynthesisUtterance(textToRead);
      utterance.rate = 0.95;
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
      setIsSpeaking(true);
    }
  };

  const formatTimerDisplay = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const nextStepText =
    currentStepIndex < totalSteps - 1 && recipe.instructions[currentStepIndex + 1]
      ? recipe.instructions[currentStepIndex + 1].text
      : null;

  const metadataBits = [
    recipe.category ? recipe.category : null,
    recipe.cuisine ? recipe.cuisine : null,
    recipe.totalTime ? recipe.totalTime : null,
    recipe.difficulty ? recipe.difficulty : null,
  ].filter(Boolean);
  const displayedTotalSteps = Math.max(totalSteps, 1);
  const displayedStepNumber = Math.min(currentStepIndex + 1, displayedTotalSteps);
  const progressPercent = Math.round((displayedStepNumber / displayedTotalSteps) * 100);

  return (
    <div
      id="fullscreen-cooking-mode"
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cooking-recipe-title"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--bg-root,#0C0C0C)] font-sans text-[var(--text-primary,#F3F4F6)] select-none"
    >
      <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-header,#111111)] px-3 py-3 sm:items-center sm:gap-4 sm:px-6 sm:py-4 lg:px-8">
        <div className="flex min-w-0 items-start gap-2.5 sm:items-center sm:gap-3">
          <div className="shrink-0">
            {showPhoto && imageUrl ? (
              <div
                role="img"
                aria-label={recipe.title}
                className="h-11 w-11 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-cover bg-center sm:h-12 sm:w-12"
                style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }}
              />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] text-[var(--accent-text,#F59E0B)] sm:h-12 sm:w-12">
                <ChefHat className="w-5 h-5" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h2
              id="cooking-recipe-title"
              className="break-words font-serif text-base font-bold leading-tight tracking-tight text-[var(--text-primary,#F3F4F6)] sm:text-lg"
            >
              {recipe.title}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug text-[var(--text-secondary,#9CA3AF)]">
              <span>Scaled for {servings} servings</span>
              {metadataBits.map((bit, i) => (
                <span key={i} className="hidden sm:inline">
                  • {bit}
                </span>
              ))}
              {wakeLockStatus === 'active' && (
                <span className="hidden items-center gap-1 rounded border border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-2 py-0.5 text-[11px] text-[var(--accent-text,#F59E0B)] sm:inline-flex">
                  <Sun className="w-3 h-3" /> Screen Awake
                </span>
              )}
              {wakeLockStatus === 'denied' && (
                <span className="hidden text-[11px] text-[var(--text-secondary,#9CA3AF)] sm:inline">
                  Wake lock unavailable
                </span>
              )}
              {wakeLockStatus === 'unsupported' && (
                <span className="hidden text-[11px] text-[var(--text-secondary,#9CA3AF)] sm:inline">
                  Wake lock not supported
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <div className="relative">
            <button
              id="cooking-timer-tray-toggle"
              type="button"
              aria-expanded={showTimerTray}
              aria-label={`Active timers: ${activeTimers.length}`}
              onClick={() => setShowTimerTray((prev) => !prev)}
              className="flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-2.5 py-2 text-xs font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)]"
            >
              <Timer className="h-4 w-4 text-[var(--accent-text,#F59E0B)]" />
              <span>{activeTimers.length}</span>
            </button>
            {showTimerTray && (
              <div
                id="cooking-timer-tray"
                className="absolute right-0 top-full z-50 mt-2 w-72 max-h-64 overflow-y-auto rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-2 shadow-2xl"
              >
                <button type="button" onClick={() => onAddCustomTimer?.()} className="mb-2 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-2 py-1.5 text-xs font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)]"><Plus className="h-3.5 w-3.5" /><span>New Custom Timer</span></button>
                {activeTimers.length === 0 && (
                  <p className="mb-2 px-2 py-1 text-xs text-[var(--text-secondary,#9CA3AF)]">No active timers.</p>
                )}
                {activeTimers.map((timer) => {
                    const isDone = timer.remainingSeconds <= 0;
                    return (
                      <div key={timer.id} className="mb-2 rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-[var(--text-primary,#F3F4F6)]">{timer.label}</span>
                          <span className={`font-mono text-xs font-bold ${isDone ? 'text-rose-400' : 'text-[var(--accent-text,#F59E0B)]'}`}>
                            {isDone ? 'DONE' : `${Math.floor(timer.remainingSeconds / 60)}:${String(timer.remainingSeconds % 60).padStart(2, '0')}`}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          {!isDone && (
                            <button
                              type="button"
                              onClick={() => onToggleTimer(timer.id)}
                              className="min-h-[32px] min-w-[32px] rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-2 text-[10px] text-[var(--text-secondary,#9CA3AF)]"
                            >
                              {timer.isRunning ? 'Pause' : 'Resume'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onDeleteTimer(timer.id)}
                            className="min-h-[32px] min-w-[32px] rounded-md border border-[var(--border-subtle,rgba(255,255,255,0.08))] px-2 text-[10px] text-[var(--text-secondary,#9CA3AF)]"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          <button
            id="toggle-ingredients-drawer-btn"
            ref={ingredientsTriggerRef}
            onClick={() => setShowIngredientsDrawer((prev) => !prev)}
            aria-pressed={showIngredientsDrawer}
            aria-label="Toggle ingredients list"
            className={`flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors sm:px-3 ${
              showIngredientsDrawer
                ? 'border-[var(--accent,#F59E0B)] bg-[var(--accent,#F59E0B)] text-[var(--accent-contrast,#0C0C0C)]'
                : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-primary,#F3F4F6)] hover:border-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-elevated,#1E1E1E)]'
            }`}
          >
            <List className="w-4 h-4" />
            <span className="hidden sm:inline">Ingredients ({recipe.ingredients.length})</span>
          </button>

          <button
            id="speak-step-btn"
            onClick={toggleSpeak}
            aria-label={isSpeaking ? 'Stop reading step aloud' : 'Read step aloud'}
            className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border p-2 transition-colors ${
              isSpeaking
                ? 'animate-pulse border-[var(--accent,#F59E0B)] bg-[var(--accent,#F59E0B)] text-[var(--accent-contrast,#0C0C0C)]'
                : 'border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]'
            }`}
            title={isSpeaking ? 'Stop reading' : 'Read step aloud'}
          >
            {isSpeaking ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            id="exit-cooking-mode-btn"
            onClick={onClose}
            aria-label="Exit cooking mode"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-2 text-[var(--text-secondary,#9CA3AF)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
            title="Exit cooking mode (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {stepAnnouncement}
      </div>

      <main className="relative min-h-0 flex-1 overflow-y-auto px-4 py-7 sm:px-8 sm:py-10 lg:px-12 lg:py-14">
        {isFinished ? (
          <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center py-8 text-center">
            <div className="space-y-6 animate-in fade-in zoom-in duration-300 motion-reduce:animate-none">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-2 border-[var(--accent,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)]">
                <Award className="w-10 h-10" />
              </div>
              <h1 className="font-serif text-3xl font-bold tracking-tight text-[var(--text-primary,#F3F4F6)] sm:text-4xl">
                Bon Appétit! 🎉
              </h1>
              <p className="mx-auto max-w-md text-base leading-relaxed text-[var(--text-secondary,#9CA3AF)]">
                You’ve completed all steps for <strong className="font-serif text-[var(--accent-text,#F59E0B)]">{recipe.title}</strong>. Ready to plate and serve!
              </p>
              <div className="flex flex-wrap justify-center gap-3 pt-4">
                <button
                  onClick={() => {
                    setIsFinished(false);
                    setCurrentStepIndex(0);
                  }}
                  className="min-h-[48px] rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-elevated,#1E1E1E)]"
                >
                  Review Steps Again
                </button>
                <button
                  onClick={onClose}
                  className="min-h-[48px] rounded-xl bg-[var(--accent,#F59E0B)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast,#0C0C0C)] shadow-lg transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                >
                  Done Cooking
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex min-h-full w-full max-w-[60ch] flex-col justify-center py-3 sm:py-6">
            <div className="space-y-8 sm:space-y-10">
              <section aria-label="Cooking progress" className="space-y-3">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--accent-text,#F59E0B)]">
                    Cooking step
                  </p>
                  <p className="font-mono text-sm font-bold tabular-nums text-[var(--text-primary,#F3F4F6)]">
                    Step {displayedStepNumber} of {displayedTotalSteps}
                  </p>
                </div>
                <div
                  role="progressbar"
                  aria-label="Cooking progress"
                  aria-valuemin={1}
                  aria-valuemax={displayedTotalSteps}
                  aria-valuenow={displayedStepNumber}
                  aria-valuetext={`Step ${displayedStepNumber} of ${displayedTotalSteps}`}
                  className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated,#1E1E1E)]"
                >
                  <div
                    className="h-full rounded-full bg-[var(--accent,#F59E0B)] transition-[width] duration-300 motion-reduce:transition-none"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </section>

              <div className="space-y-6 sm:space-y-8">
                <p className="font-serif text-[1.375rem] font-medium leading-[1.48] tracking-[-0.01em] text-[var(--text-primary,#F3F4F6)] sm:text-3xl lg:text-[2rem]">
                  {formatInline(currentStep.text)}
                </p>

                {stepTimer ? (
                  <div className="inline-flex max-w-full flex-wrap items-center gap-3 rounded-2xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-4 py-2.5 shadow-xl sm:px-5">
                    <Timer className="h-5 w-5 text-[var(--accent-text,#F59E0B)]" />
                    <span className="font-mono text-2xl font-bold tabular-nums text-[var(--accent-text,#F59E0B)]">
                      {formatTimerDisplay(stepTimer.remainingSeconds)}
                    </span>
                    <button
                      onClick={() => onToggleTimer(stepTimer.id)}
                      aria-label={stepTimer.isRunning ? 'Pause timer' : 'Resume timer'}
                      className={`flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl font-bold transition-colors ${
                        stepTimer.isRunning
                          ? 'bg-[var(--accent,#F59E0B)] text-[var(--accent-contrast,#0C0C0C)] hover:bg-[var(--accent-hover,#D97706)]'
                          : 'border border-[var(--accent-text,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] text-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-surface,#141414)]'
                      }`}
                      title={stepTimer.isRunning ? 'Pause timer' : 'Resume timer'}
                    >
                      {stepTimer.isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                    </button>
                    <button
                      onClick={() =>
                        onStartTimer(recipe.title, currentStep.timerMinutes!, `Step ${stepNumber}: ${currentStep.timerMinutes}m`, stepKey)
                      }
                      aria-label="Restart step timer"
                      className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
                      title="Restart step timer"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDeleteTimer(stepTimer.id)}
                      aria-label="Dismiss timer"
                      className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] text-[var(--text-secondary,#9CA3AF)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:text-[var(--accent-text,#F59E0B)]"
                      title="Dismiss timer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  currentStep.timerMinutes && (
                    <button
                      onClick={() =>
                        onStartTimer(recipe.title, currentStep.timerMinutes, `Step ${stepNumber}: ${currentStep.timerMinutes}m`, stepKey)
                      }
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-[var(--accent,#F59E0B)] px-4 py-2.5 text-sm font-bold text-[var(--accent-contrast,#0C0C0C)] shadow-lg transition-colors hover:bg-[var(--accent-hover,#D97706)]"
                    >
                      <Timer className="w-4 h-4" />
                      <span>Start {currentStep.timerMinutes} min Timer</span>
                    </button>
                  )
                )}

                {nextStepText && (
                  <aside className="border-l-2 border-[var(--accent,#F59E0B)] bg-[var(--accent-subtle,rgba(245,158,11,0.15))] px-4 py-3.5 sm:px-5">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--accent-text,#F59E0B)]">Up next</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-secondary,#9CA3AF)] sm:text-base">
                      {formatInline(nextStepText)}
                    </p>
                  </aside>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {showIngredientsDrawer && (
        <aside
          ref={ingredientSheetRef as any}
          className="absolute right-0 top-0 bottom-0 z-40 w-full max-w-full overflow-y-auto border-l border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] p-5 pb-[env(safe-area-inset-bottom)] shadow-2xl animate-in slide-in-from-right duration-200 motion-reduce:animate-none sm:w-80"
          aria-label="Ingredients"
        >
          <div className="mb-3 flex items-center justify-between border-b border-[var(--border-subtle,rgba(255,255,255,0.08))] pb-3">
            <h3 className="font-serif text-sm font-bold text-[var(--text-primary,#F3F4F6)]">
              Ingredients ({servings} servings)
            </h3>
            <button
              onClick={() => setShowIngredientsDrawer(false)}
              className="min-h-[44px] min-w-[44px] text-xs text-[var(--text-secondary,#9CA3AF)] hover:text-[var(--accent-text,#F59E0B)]"
            >
              Close
            </button>
          </div>
          <ul className="space-y-2.5 text-sm text-[var(--text-secondary,#9CA3AF)]">
            {recipe.ingredients.map((ing, idx) => {
              const cleanText = (ing.original || '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
              return (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-text,#F59E0B)]" />
                  <span className="leading-relaxed">{scaleIngredientText(cleanText, baseServings, servings)}</span>
                </li>
              );
            })}
          </ul>
          {recipe.ingredients.length === 0 && (
            <p className="text-xs text-[var(--text-muted,#6B7280)]">No ingredients listed.</p>
          )}
        </aside>
      )}

      {!isFinished && (
        <footer className="shrink-0 border-t border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-header,#111111)] px-4 py-4 sm:px-6 sm:py-5 lg:px-12">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 sm:gap-4">
            <button
              id="cooking-prev-step-btn"
              onClick={handlePrevStep}
              disabled={currentStepIndex === 0}
              aria-label="Previous step"
              className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-surface,#141414)] px-4 py-2.5 text-sm font-semibold text-[var(--text-primary,#F3F4F6)] transition-colors hover:border-[var(--accent-text,#F59E0B)] hover:bg-[var(--bg-elevated,#1E1E1E)] disabled:pointer-events-none disabled:opacity-50 sm:flex-none"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Previous</span>
            </button>

            <span className="hidden text-center text-[11px] text-[var(--text-muted,#6B7280)] sm:inline">
              Use <kbd className="rounded border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[var(--text-secondary,#9CA3AF)]">←</kbd> <kbd className="rounded border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[var(--text-secondary,#9CA3AF)]">→</kbd> or <kbd className="rounded border border-[var(--border-subtle,rgba(255,255,255,0.08))] bg-[var(--bg-elevated,#1E1E1E)] px-1.5 py-0.5 text-[var(--text-secondary,#9CA3AF)]">Space</kbd>
            </span>

            <button
              id="cooking-next-step-btn"
              onClick={handleNextStep}
              aria-label={currentStepIndex === totalSteps - 1 ? 'Finish cooking' : 'Next step'}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent,#F59E0B)] px-6 py-2.5 text-sm font-bold text-[var(--accent-contrast,#0C0C0C)] shadow-lg transition-colors hover:bg-[var(--accent-hover,#D97706)] sm:flex-none"
            >
              <span>{currentStepIndex === totalSteps - 1 ? 'Finish Cooking 🎉' : 'Next Step'}</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
