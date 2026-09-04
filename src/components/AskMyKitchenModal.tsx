import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  X,
  Send,
  Search,
  AlertCircle,
  RefreshCw,
  ChevronRight,
  BookOpen,
} from 'lucide-react';
import { ObsidianRecipe } from '../types';
import { searchKitchenRecipes, type KitchenQuery } from '../utils/kitchenSearch';
import {
  buildAnswerEvidence,
  type KitchenAnswer,
  type KitchenAnswerItem,
} from '../utils/kitchenAnswer';
import {
  applyTrustedSimilarContext,
  buildAnswerRequest,
  buildInterpretRequest,
  httpErrorMessage,
  INVALID_RESPONSE_MESSAGE,
  isAnswerResponse,
  isInterpretResponse,
  NETWORK_ERROR_MESSAGE,
  resolveAnswerRecipe,
} from '../utils/askMyKitchenUi';

type AskStatus =
  | 'idle'
  | 'interpreting'
  | 'searching'
  | 'answering'
  | 'success'
  | 'noMatches'
  | 'error';

interface AskMyKitchenModalProps {
  isOpen: boolean;
  onClose: () => void;
  allRecipes: ObsidianRecipe[];
  /** Trusted context from the current Recipe Detail, if Ask My Kitchen was opened there. */
  currentRecipe?: ObsidianRecipe | null;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
}

const MAX_QUESTION_LENGTH = 500;

function progressLabel(status: AskStatus): string {
  switch (status) {
    case 'interpreting':
      return 'Understanding your question...';
    case 'searching':
      return 'Searching your vault...';
    case 'answering':
      return 'Preparing your answer...';
    default:
      return '';
  }
}

function renderAnswerItem(
  item: KitchenAnswerItem,
  allRecipes: ObsidianRecipe[],
  onSelectRecipe: (recipe: ObsidianRecipe) => void
) {
  const recipe = resolveAnswerRecipe(item.recipeIdentity, allRecipes);
  const title = item.title || item.recipeIdentity;

  if (!recipe) {
    return (
      <li
        key={item.recipeIdentity}
        className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl bg-[#171717] border border-white/5 text-left"
      >
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold text-gray-300 truncate block">{title}</span>
          {item.explanation && (
            <span className="text-[11px] text-gray-500 block truncate">{item.explanation}</span>
          )}
        </div>
        <span className="text-[10px] text-gray-600 shrink-0">Recipe not found</span>
      </li>
    );
  }

  return (
    <li key={item.recipeIdentity}>
      <button
        id={`ask-recipe-${item.recipeIdentity}`}
        onClick={() => onSelectRecipe(recipe)}
        className="w-full flex items-center justify-between gap-3 p-2.5 rounded-xl bg-[#171717] hover:bg-[#1C1C1C] border border-white/5 hover:border-amber-500/30 transition-all group text-left"
      >
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold text-white group-hover:text-amber-300 truncate block">
            {title}
          </span>
          {item.explanation && (
            <span className="text-[11px] text-gray-500 block truncate">{item.explanation}</span>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-gray-500 group-hover:text-amber-400 transition-colors shrink-0" />
      </button>
    </li>
  );
}

export function AskMyKitchenModal({
  isOpen,
  onClose,
  allRecipes,
  currentRecipe,
  onSelectRecipe,
}: AskMyKitchenModalProps) {
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<AskStatus>('idle');
  const [answer, setAnswer] = useState<KitchenAnswer | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);

  // Trusted similar-to context (never derived from the model).
  const trustedIdentity = currentRecipe?.id || currentRecipe?.filePath || currentRecipe?.fileName;

  const reset = useCallback(() => {
    setStatus('idle');
    setAnswer(null);
    setErrorMsg(null);
  }, []);

  const handleClose = useCallback(() => {
    tokenRef.current += 1; // invalidate any in-flight request
    reset();
    onClose();
  }, [onClose, reset]);

  const handleSelectRecipe = useCallback(
    (recipe: ObsidianRecipe) => {
      tokenRef.current += 1; // invalidate any in-flight request
      reset();
      onSelectRecipe(recipe);
    },
    [onSelectRecipe, reset]
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (isOpen) {
      // focus the question box when the modal opens
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isBusy = status === 'interpreting' || status === 'searching' || status === 'answering';

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isBusy || trimmed.length > MAX_QUESTION_LENGTH) return;

    const token = (tokenRef.current += 1);
    setStatus('interpreting');
    setAnswer(null);
    setErrorMsg(null);

    try {
      // A) Interpret the question.
      const interpretRes = await fetch('/api/kitchen/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildInterpretRequest(trimmed)),
      });
      const interpretData = await interpretRes.json().catch(() => null);
      if (tokenRef.current !== token) return;
      if (!interpretRes.ok) {
        setStatus('error');
        setErrorMsg(httpErrorMessage(interpretRes.status));
        return;
      }
      if (!isInterpretResponse(interpretData)) {
        setStatus('error');
        setErrorMsg(INVALID_RESPONSE_MESSAGE);
        return;
      }

      // Apply trusted similar-to context AFTER interpretation (never the model's).
      const query = applyTrustedSimilarContext(interpretData.query, trustedIdentity, trimmed);

      // B) Deterministic local retrieval (Step 1).
      setStatus('searching');
      const results = searchKitchenRecipes(allRecipes, query);

      // C) Build compact evidence (Step 3) — no vault data leaves the client.
      setStatus('answering');
      const evidence = buildAnswerEvidence(results);

      // D) Ask the server for a grounded answer.
      const answerRes = await fetch('/api/kitchen/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAnswerRequest(trimmed, query, evidence)),
      });
      const answerData = await answerRes.json().catch(() => null);
      if (tokenRef.current !== token) return;
      if (!answerRes.ok) {
        setStatus('error');
        setErrorMsg(httpErrorMessage(answerRes.status));
        return;
      }
      if (!isAnswerResponse(answerData)) {
        setStatus('error');
        setErrorMsg(INVALID_RESPONSE_MESSAGE);
        return;
      }

      const grounded: KitchenAnswer = {
        ok: true,
        noMatches: answerData.noMatches,
        summary: answerData.summary,
        items: answerData.items,
        source: answerData.source as KitchenAnswer['source'],
      };
      setAnswer(grounded);
      setStatus(answerData.noMatches ? 'noMatches' : 'success');
    } catch {
      if (tokenRef.current !== token) return;
      setStatus('error');
      setErrorMsg(NETWORK_ERROR_MESSAGE);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div
        id="ask-my-kitchen-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-my-kitchen-title"
        className="bg-[#141414] border border-white/10 rounded-2xl max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh] text-gray-200"
      >
        {/* Header */}
        <div className="p-5 border-b border-white/5 flex items-center justify-between bg-[#191919]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="ask-my-kitchen-title" className="font-serif font-bold text-base text-white">
                  Ask My Kitchen
                </h2>
                <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 font-semibold border border-amber-500/20">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  Your Vault Only
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Ask a question and I&apos;ll search your vault and suggest recipes.
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close Ask My Kitchen"
            className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Question Input */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <label htmlFor="ask-my-kitchen-question" className="block text-xs font-semibold text-gray-300">
              What would you like to make?
            </label>
            <div className="flex items-center gap-2">
              <input
                id="ask-my-kitchen-question"
                ref={inputRef}
                type="text"
                value={question}
                maxLength={MAX_QUESTION_LENGTH}
                disabled={isBusy}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="e.g. What can I make with chicken and rice?"
                className="flex-1 px-3 py-2.5 text-sm bg-[#0C0C0C] border border-white/10 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/40 disabled:opacity-60 transition-all"
              />
              <button
                id="ask-my-kitchen-submit"
                type="submit"
                disabled={isBusy || !question.trim()}
                className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-xl bg-amber-500 hover:bg-amber-400 text-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-4 h-4" />
                <span>Ask</span>
              </button>
            </div>
            {currentRecipe && (
              <p className="text-[11px] text-gray-500">
                Opened from <span className="text-gray-300">{currentRecipe.title}</span> — ask
                &quot;what is similar to this?&quot; to find related recipes.
              </p>
            )}
          </form>

          {/* Busy / progress */}
          {isBusy && (
            <div className="flex items-center gap-3 text-xs text-gray-400 bg-[#0C0C0C] border border-white/5 rounded-xl px-4 py-3">
              <Search className="w-4 h-4 text-amber-400 animate-pulse" />
              <span>{progressLabel(status)}</span>
            </div>
          )}

          {/* Error */}
          {status === 'error' && errorMsg && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* No matches */}
          {status === 'noMatches' && answer && (
            <div className="space-y-3">
              <p className="text-sm text-gray-200">{answer.summary}</p>
              <button
                onClick={() => {
                  setQuestion('');
                  reset();
                  inputRef.current?.focus();
                }}
                className="flex items-center gap-1.5 text-xs font-semibold text-amber-300 hover:text-amber-200"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Trying another question
              </button>
            </div>
          )}

          {/* Success */}
          {status === 'success' && answer && (
            <div className="space-y-4">
              <p className="text-sm text-gray-200">{answer.summary}</p>
              <ul className="space-y-2">
                {answer.items.map((item) => renderAnswerItem(item, allRecipes, handleSelectRecipe))}
              </ul>
            </div>
          )}

          {/* Idle hint */}
          {status === 'idle' && (
            <div className="flex items-start gap-2.5 text-xs text-gray-500 bg-[#0C0C0C] border border-white/5 rounded-xl px-4 py-3">
              <BookOpen className="w-4 h-4 shrink-0 mt-0.5 text-amber-400/70" />
              <p>
                I search only your vault, never the web. Try &quot;what can I make with chicken and
                rice?&quot;, &quot;what desserts take under 30 minutes?&quot;, or &quot;my favorite
                Italian recipes&quot;.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
