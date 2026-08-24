import React, { useState, useEffect, useRef } from 'react';
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
  CheckCircle2,
  List,
  Sparkles,
  Sun,
  ChefHat,
  Flame,
  Award,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { ObsidianRecipe, ActiveTimer } from '../types';
import { scaleIngredientText } from '../utils/markdownParser';
import { playTimerChime } from '../utils/audioAlert';

interface CookingModeModalProps {
  recipe: ObsidianRecipe;
  servings: number;
  onClose: () => void;
  onStartTimer: (recipeTitle: string, minutes: number, label: string) => void;
}

export function CookingModeModal({
  recipe,
  servings,
  onClose,
  onStartTimer,
}: CookingModeModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showIngredientsDrawer, setShowIngredientsDrawer] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Record<number, boolean>>({});
  const [isFinished, setIsFinished] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  // Local step timer
  const [stepTimerSeconds, setStepTimerSeconds] = useState<number | null>(null);
  const [isStepTimerRunning, setIsStepTimerRunning] = useState(false);
  const stepTimerRef = useRef<any>(null);

  const totalSteps = recipe.instructions.length;
  const currentStep = recipe.instructions[currentStepIndex] || { text: 'Enjoy your meal!', stepNumber: 1 };
  const baseServings = recipe.servings || 4;

  // Request Screen Wake Lock to prevent screen from sleeping while cooking
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
      if (stepTimerRef.current) {
        clearInterval(stepTimerRef.current);
      }
    };
  }, []);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        handleNextStep();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevStep();
      } else if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentStepIndex, totalSteps]);

  // Setup timer when step has detected duration
  useEffect(() => {
    if (currentStep.timerMinutes) {
      setStepTimerSeconds(currentStep.timerMinutes * 60);
      setIsStepTimerRunning(false);
    } else {
      setStepTimerSeconds(null);
      setIsStepTimerRunning(false);
    }
  }, [currentStepIndex]);

  // Timer countdown loop
  useEffect(() => {
    if (isStepTimerRunning && stepTimerSeconds !== null && stepTimerSeconds > 0) {
      stepTimerRef.current = setInterval(() => {
        setStepTimerSeconds((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(stepTimerRef.current);
            setIsStepTimerRunning(false);
            playTimerChime();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    }
    return () => {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current);
    };
  }, [isStepTimerRunning, stepTimerSeconds]);

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

  return (
    <div
      id="fullscreen-cooking-mode"
      className="fixed inset-0 z-50 bg-[#0C0C0C] text-gray-200 flex flex-col justify-between select-none"
    >
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 sm:px-8 py-4 border-b border-white/5 bg-[#141414] backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <ChefHat className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-serif font-bold text-white truncate">
              {recipe.title}
            </h2>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>Scaled for {servings} servings</span>
              {wakeLockActive && (
                <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-amber-400 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                  <Sun className="w-3 h-3" /> Screen Awake
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Ingredients Drawer Toggle */}
          <button
            id="toggle-ingredients-drawer-btn"
            onClick={() => setShowIngredientsDrawer((prev) => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              showIngredientsDrawer
                ? 'bg-amber-500 text-black border-amber-400'
                : 'bg-white/5 hover:bg-white/10 text-gray-200 border-white/10'
            }`}
          >
            <List className="w-4 h-4" />
            <span className="hidden sm:inline">Ingredients ({recipe.ingredients.length})</span>
          </button>

          {/* Text to Speech */}
          <button
            id="speak-step-btn"
            onClick={toggleSpeak}
            className={`p-2 rounded-lg border transition-colors ${
              isSpeaking
                ? 'bg-amber-500 text-black border-amber-400 animate-pulse'
                : 'bg-white/5 hover:bg-white/10 text-gray-300 border-white/10'
            }`}
            title={isSpeaking ? 'Stop reading' : 'Read step aloud'}
          >
            {isSpeaking ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          {/* Close Button */}
          <button
            id="exit-cooking-mode-btn"
            onClick={onClose}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 transition-colors"
            title="Exit cooking mode (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="relative flex-1 flex flex-col justify-center items-center px-6 sm:px-12 max-w-4xl mx-auto w-full text-center">
        {isFinished ? (
          /* Finished State */
          <div className="space-y-6 animate-in fade-in zoom-in duration-300">
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
                className="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-200 text-sm font-semibold border border-white/10"
              >
                Review Steps Again
              </button>
              <button
                onClick={onClose}
                className="px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold shadow-lg shadow-amber-500/20"
              >
                Done Cooking
              </button>
            </div>
          </div>
        ) : (
          /* Step Presentation */
          <div className="w-full space-y-8">
            {/* Step Counter Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-amber-400 font-mono text-sm font-bold">
              <span>Step {currentStepIndex + 1} of {totalSteps}</span>
            </div>

            {/* Big Step Instruction Text */}
            <div className="min-h-[140px] flex items-center justify-center">
              <p className="text-xl sm:text-2xl md:text-3xl font-serif font-medium text-gray-100 leading-relaxed max-w-3xl">
                {currentStep.text}
              </p>
            </div>

            {/* Step Timer Control */}
            {stepTimerSeconds !== null && (
              <div className="inline-flex items-center gap-3 bg-[#141414] border border-white/10 px-5 py-2.5 rounded-2xl shadow-xl">
                <Timer className="w-5 h-5 text-amber-400" />
                <span className="font-mono text-2xl font-bold text-amber-300">
                  {formatTimerDisplay(stepTimerSeconds)}
                </span>
                <button
                  onClick={() => setIsStepTimerRunning((prev) => !prev)}
                  className={`p-2 rounded-xl text-black font-bold transition-colors ${
                    isStepTimerRunning ? 'bg-amber-400 hover:bg-amber-300' : 'bg-amber-500 hover:bg-amber-400'
                  }`}
                >
                  {isStepTimerRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                </button>
                <button
                  onClick={() => {
                    setIsStepTimerRunning(false);
                    setStepTimerSeconds(currentStep.timerMinutes! * 60);
                  }}
                  className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white border border-white/10 transition-colors"
                  title="Reset Timer"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Slide-out Ingredients Drawer */}
      {showIngredientsDrawer && (
        <div className="absolute right-0 top-16 bottom-20 w-80 max-w-full bg-[#141414] border-l border-white/10 p-5 overflow-y-auto shadow-2xl z-40 animate-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/10">
            <h3 className="font-serif font-bold text-sm text-white">
              Ingredients ({servings} servings)
            </h3>
            <button
              onClick={() => setShowIngredientsDrawer(false)}
              className="text-xs text-gray-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <ul className="space-y-2.5 text-xs text-gray-300">
            {recipe.ingredients.map((ing, idx) => {
              const cleanText = (ing.original || '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1');
              return (
                <li key={idx} className="flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 mt-1.5" />
                  <span>{scaleIngredientText(cleanText, baseServings, servings)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Bottom Navigation Controls & Progress */}
      <div className="px-6 sm:px-12 py-5 border-t border-white/5 bg-[#141414] backdrop-blur-md">
        {/* Step Progress Bar */}
        <div className="w-full bg-white/5 rounded-full h-1.5 mb-4 overflow-hidden">
          <div
            className="bg-amber-500 h-full transition-all duration-300"
            style={{
              width: `${((currentStepIndex + (isFinished ? 1 : 0)) / totalSteps) * 100}%`,
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 max-w-4xl mx-auto">
          {/* Previous Step Button */}
          <button
            id="cooking-prev-step-btn"
            onClick={handlePrevStep}
            disabled={currentStepIndex === 0 && !isFinished}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:pointer-events-none text-gray-200 border border-white/10 text-sm font-semibold transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Previous</span>
          </button>

          {/* Quick Shortcuts hint */}
          <span className="text-[11px] text-gray-500 hidden sm:inline">
            Press <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300">Space</kbd> or <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-300">→</kbd> to advance
          </span>

          {/* Next / Complete Step Button */}
          <button
            id="cooking-next-step-btn"
            onClick={handleNextStep}
            className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold shadow-lg shadow-amber-500/20 transition-colors"
          >
            <span>{currentStepIndex === totalSteps - 1 ? 'Finish Cooking 🎉' : 'Next Step'}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
