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
  onClose: () => void;
}

function formatInline(text: string): React.ReactNode {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      return (
        <strong key={i} className="font-semibold text-white">
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
  onClose,
}: CookingModeModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showIngredientsDrawer, setShowIngredientsDrawer] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Record<number, boolean>>({});
  const [isFinished, setIsFinished] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);

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

  useEffect(() => {
    let wakeLock: any = null;
    async function requestWakeLock() {
      if ('wakeLock' in navigator) {
        try {
          wakeLock = await (navigator as any).wakeLock.request('screen');
          setWakeLockActive(true);
        } catch (err) {
          console.warn('Wake Lock error:', err);
        }
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
  }, [currentStepIndex, totalSteps]);

  const handleNextStep = () => {
    setCompletedSteps((prev) => ({ ...prev, [currentStepIndex]: true }));
    if (currentStepIndex < totalSteps - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      setIsFinished(true);
      confetti({
        particleCount: 120,
        spread: 80,
        origin: { y: 0.6 },
      });
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

  return (
    <div
      id="fullscreen-cooking-mode"
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cooking-recipe-title"
      className="fixed inset-0 z-50 bg-[#0C0C0C] text-gray-200 flex flex-col select-none overflow-hidden"
    >
      <header className="flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 border-b border-white/5 bg-[#141414] backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0">
            {showPhoto && imageUrl ? (
              <div
                role="img"
                aria-label={recipe.title}
                className="w-11 h-11 sm:w-12 sm:h-12 rounded-lg border border-white/10 bg-cover bg-center"
                style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }}
              />
            ) : (
              <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-lg bg-[#0C0C0C] border border-white/10 flex items-center justify-center text-amber-400">
                <ChefHat className="w-5 h-5" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h2
              id="cooking-recipe-title"
              className="text-base sm:text-lg font-serif font-bold text-white truncate"
            >
              {recipe.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
              <span>Scaled for {servings} servings</span>
              {metadataBits.map((bit, i) => (
                <span key={i} className="hidden sm:inline">
                  • {bit}
                </span>
              ))}
              {wakeLockActive && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
                  <Sun className="w-3 h-3" /> Screen Awake
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            id="toggle-ingredients-drawer-btn"
            onClick={() => setShowIngredientsDrawer((prev) => !prev)}
            aria-pressed={showIngredientsDrawer}
            aria-label="Toggle ingredients list"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors min-h-[44px] ${
              showIngredientsDrawer
                ? 'bg-amber-500 text-black border-amber-400'
                : 'bg-white/5 hover:bg-white/10 text-gray-200 border-white/10'
            }`}
          >
            <List className="w-4 h-4" />
            <span className="hidden sm:inline">Ingredients ({recipe.ingredients.length})</span>
          </button>

          <button
            id="speak-step-btn"
            onClick={toggleSpeak}
            aria-label={isSpeaking ? 'Stop reading step aloud' : 'Read step aloud'}
            className={`p-2 rounded-lg border transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center ${
              isSpeaking
                ? 'bg-amber-500 text-black border-amber-400 animate-pulse'
                : 'bg-white/5 hover:bg-white/10 text-gray-300 border-white/10'
            }`}
            title={isSpeaking ? 'Stop reading' : 'Read step aloud'}
          >
            {isSpeaking ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <button
            id="exit-cooking-mode-btn"
            onClick={onClose}
            aria-label="Exit cooking mode"
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
            title="Exit cooking mode (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="relative flex-1 flex flex-col items-center justify-center px-4 sm:px-8 lg:px-12 py-6 sm:py-10 overflow-y-auto">
        {isFinished ? (
          <div className="space-y-6 animate-in fade-in zoom-in duration-300 text-center max-w-xl">
            <div className="w-20 h-20 rounded-full bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center mx-auto text-emerald-400">
              <Award className="w-10 h-10" />
            </div>
            <h1 className="text-3xl sm:text-4xl font-serif font-bold text-white">
              Bon Appétit! 🎉
            </h1>
            <p className="text-gray-300 max-w-md mx-auto text-base leading-relaxed">
              You’ve completed all steps for <strong className="text-amber-300 font-serif">{recipe.title}</strong>. Ready to plate and serve!
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-4">
              <button
                onClick={() => {
                  setIsFinished(false);
                  setCurrentStepIndex(0);
                }}
                className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 text-sm font-semibold border border-white/10 min-h-[44px]"
              >
                Review Steps Again
              </button>
              <button
                onClick={onClose}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold shadow-lg shadow-amber-500/20 min-h-[44px]"
              >
                Done Cooking
              </button>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-3xl space-y-6 sm:space-y-8 text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-gray-200 font-mono text-sm font-bold">
              <span>Step {currentStepIndex + 1} of {totalSteps}</span>
            </div>

            <div className="min-h-[120px] sm:min-h-[160px] flex items-center justify-center">
              <p className="text-xl sm:text-2xl md:text-3xl font-serif font-medium text-white leading-relaxed max-w-3xl">
                {formatInline(currentStep.text)}
              </p>
            </div>

            {stepTimer ? (
              <div className="inline-flex items-center gap-3 bg-[#141414] border border-white/10 px-4 sm:px-5 py-2.5 rounded-2xl shadow-xl">
                <Timer className="w-5 h-5 text-amber-400" />
                <span className="font-mono text-2xl font-bold text-amber-300">
                  {formatTimerDisplay(stepTimer.remainingSeconds)}
                </span>
                <button
                  onClick={() => onToggleTimer(stepTimer.id)}
                  aria-label={stepTimer.isRunning ? 'Pause timer' : 'Resume timer'}
                  className={`p-2 rounded-xl text-black font-bold transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center ${
                    stepTimer.isRunning ? 'bg-amber-400 hover:bg-amber-300' : 'bg-amber-500 hover:bg-amber-400'
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
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
                  title="Restart step timer"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onDeleteTimer(stepTimer.id)}
                  aria-label="Dismiss timer"
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
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
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold shadow-lg shadow-amber-500/20 transition-colors min-h-[44px]"
                >
                  <Timer className="w-4 h-4" />
                  <span>Start {currentStep.timerMinutes} min Timer</span>
                </button>
              )
            )}

            {nextStepText && (
              <p className="text-xs sm:text-sm text-gray-300 max-w-2xl mx-auto line-clamp-2">
                <span className="font-semibold text-gray-200">Next:</span> {formatInline(nextStepText)}
              </p>
            )}
          </div>
        )}
      </main>

      {showIngredientsDrawer && (
        <aside
          className="absolute right-0 top-0 bottom-0 w-full sm:w-80 max-w-full bg-[#141414] border-l border-white/5 p-5 overflow-y-auto shadow-2xl z-40 animate-in slide-in-from-right duration-200"
          aria-label="Ingredients"
        >
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
            <h3 className="font-serif font-bold text-sm text-white">
              Ingredients ({servings} servings)
            </h3>
            <button
              onClick={() => setShowIngredientsDrawer(false)}
              className="text-xs text-gray-400 hover:text-white min-h-[44px] min-w-[44px]"
            >
              Close
            </button>
          </div>
          <ul className="space-y-2.5 text-sm text-gray-300">
            {recipe.ingredients.map((ing, idx) => {
              const cleanText = (ing.original || '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
              return (
                <li key={idx} className="flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 mt-2" />
                  <span className="leading-relaxed">{scaleIngredientText(cleanText, baseServings, servings)}</span>
                </li>
              );
            })}
          </ul>
          {recipe.ingredients.length === 0 && (
            <p className="text-xs text-gray-500">No ingredients listed.</p>
          )}
        </aside>
      )}

      <footer className="px-4 sm:px-6 lg:px-12 py-4 sm:py-5 border-t border-white/5 bg-[#141414] backdrop-blur-md shrink-0">
        <div className="w-full bg-white/5 rounded-full h-1.5 mb-4 overflow-hidden">
          <div
            className="bg-amber-500 h-full transition-all duration-300 motion-reduce:transition-none"
            style={{
              width: `${((currentStepIndex + (isFinished ? 1 : 0)) / (totalSteps || 1)) * 100}%`,
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 max-w-4xl mx-auto">
          <button
            id="cooking-prev-step-btn"
            onClick={handlePrevStep}
            disabled={currentStepIndex === 0 && !isFinished}
            aria-label="Previous step"
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:pointer-events-none text-gray-200 border border-white/10 text-sm font-semibold transition-colors min-h-[44px]"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Previous</span>
          </button>

          <span className="text-[11px] text-gray-500 hidden sm:inline text-center">
            Press <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300">Space</kbd> or <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300">→</kbd> to advance
          </span>

          <button
            id="cooking-next-step-btn"
            onClick={handleNextStep}
            aria-label={currentStepIndex === totalSteps - 1 ? 'Finish cooking' : 'Next step'}
            className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold shadow-lg shadow-amber-500/20 transition-colors min-h-[44px]"
          >
            <span>{currentStepIndex === totalSteps - 1 ? 'Finish Cooking 🎉' : 'Next Step'}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </footer>
    </div>
  );
}
