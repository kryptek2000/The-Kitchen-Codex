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
import type { KitchenAnswer, KitchenAnswerItem } from '../utils/kitchenAnswer';
import { buildRecipeRelationshipIndex } from '../utils/recipeRelationships';
import {
  buildGroundedKitchenAnswer,
  buildKitchenCandidates,
  rankKitchenCandidates,
  sanitizeAiRankedCandidates,
} from '../utils/kitchenRanking';
import {
  buildInterpretRequest,
  buildRankRequest,
  httpErrorMessage,
  INVALID_RESPONSE_MESSAGE,
  intentBlockedMessage,
  isInterpretResponse,
  isIntentRuntimeSupported,
  NETWORK_ERROR_MESSAGE,
  resolveAnswerRecipe,
  RUNTIME_NOT_SUPPORTED_MESSAGE,
} from '../utils/askMyKitchenUi';
import {
  buildKitchenDiscoveryRequest,
  canOfferWebDiscovery,
  getDiscoveryAuthorization,
  isKitchenDiscoveryResponse,
  sanitizeWebResults,
  MAX_WEB_RESULTS,
  type KitchenWebResult,
} from '../utils/kitchenDiscovery';
import {
  prepareKitchenIntentForExecution,
} from '../utils/kitchenIntentPolicy';
import type { KitchenIntent, TrustedKitchenContext } from '../utils/kitchenIntent';

type AskStatus =
  | 'idle'
  | 'interpreting'
  | 'searching'
  | 'answering'
  | 'success'
  | 'noMatches'
  | 'error';

type WebStatus = 'idle' | 'offering' | 'discovering' | 'done' | 'unavailable';

interface AskMyKitchenModalProps {
  isOpen: boolean;
  onClose: () => void;
  allRecipes: ObsidianRecipe[];
  /** Trusted context from the current Recipe Detail, if Ask My Kitchen was opened there. */
  currentRecipe?: ObsidianRecipe | null;
  onSelectRecipe: (recipe: ObsidianRecipe) => void;
}

const MAX_QUESTION_LENGTH = 500;

function progressLabel(status: AskStatus, webStatus: WebStatus): string {
  if (webStatus === 'discovering') return 'Searching the web...';
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-bold tracking-wider text-amber-400/80 uppercase">{children}</span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  );
}

function renderWebResultCard(result: KitchenWebResult) {
  return (
    <li
      key={result.id}
      className="w-full p-2.5 rounded-xl bg-[#171717] border border-white/5 text-left"
    >
      <a
        href={result.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group block"
      >
        <span className="text-xs font-semibold text-white group-hover:text-amber-300 truncate block">
          {result.title}
        </span>
        {result.sourceName && (
          <span className="text-[10px] text-gray-500 block truncate">{result.sourceName}</span>
        )}
        {result.snippet && (
          <span className="text-[11px] text-gray-400 block mt-0.5 truncate font-normal">{result.snippet}</span>
        )}
        <span className="text-[11px] text-amber-400 inline-flex items-center gap-1 mt-1">
          View source
        </span>
      </a>
    </li>
  );
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
  const [webResults, setWebResults] = useState<KitchenWebResult[]>([]);
  const [webStatus, setWebStatus] = useState<WebStatus>('idle');
  const [showWebOffer, setShowWebOffer] = useState(false);
  const [isExplicitWeb, setIsExplicitWeb] = useState(false);
  const [webEligible, setWebEligible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);
  const activeIntentRef = useRef<KitchenIntent | null>(null);
  const activeQuestionRef = useRef('');

  // Trusted similar-to context (never derived from the model).
  const trustedIdentity = currentRecipe?.id || currentRecipe?.filePath || currentRecipe?.fileName;

  const reset = useCallback(() => {
    setStatus('idle');
    setAnswer(null);
    setErrorMsg(null);
    setWebResults([]);
    setWebStatus('idle');
    setShowWebOffer(false);
    setIsExplicitWeb(false);
    setWebEligible(false);
    activeIntentRef.current = null;
    activeQuestionRef.current = '';
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

  const isBusy =
    status === 'interpreting' ||
    status === 'searching' ||
    status === 'answering' ||
    webStatus === 'discovering';

  const discoverWeb = async (question: string, intent: KitchenIntent, token: number) => {
    setWebStatus('discovering');
    try {
      const request = buildKitchenDiscoveryRequest(question, intent, MAX_WEB_RESULTS);
      const res = await fetch('/api/kitchen/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await res.json().catch(() => null);
      if (tokenRef.current !== token) return;
      if (res.ok && isKitchenDiscoveryResponse(data)) {
        const results = sanitizeWebResults(data.results, { maxResults: MAX_WEB_RESULTS });
        setWebResults(results);
        setWebStatus(results.length ? 'done' : 'unavailable');
      } else {
        setWebResults([]);
        setWebStatus('unavailable');
      }
    } catch {
      if (tokenRef.current !== token) return;
      setWebResults([]);
      setWebStatus('unavailable');
    }
  };

  const handleOfferWeb = async () => {
    const intent = activeIntentRef.current;
    if (!intent) return;
    setShowWebOffer(false);
    const token = (tokenRef.current += 1);
    await discoverWeb(activeQuestionRef.current, intent, token);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isBusy || trimmed.length > MAX_QUESTION_LENGTH) return;

    const token = (tokenRef.current += 1);
    setStatus('interpreting');
    setAnswer(null);
    setErrorMsg(null);
    setWebResults([]);
    setWebStatus('idle');
    setShowWebOffer(false);
    setIsExplicitWeb(false);

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

      // Prepare the sanitized intent with CLIENT-Owned trusted context. The model
      // never supplies recipe IDs; only the trusted current recipe does.
      const trustedContext: TrustedKitchenContext = { currentRecipeId: trustedIdentity };
      const prepared = prepareKitchenIntentForExecution(interpretData.intent, trustedContext);
      if (!prepared.ok) {
        setStatus('error');
        setErrorMsg(INVALID_RESPONSE_MESSAGE);
        return;
      }
      if (!prepared.readiness.executable) {
        setStatus('error');
        setErrorMsg(intentBlockedMessage(prepared.readiness));
        return;
      }

      activeIntentRef.current = prepared.intent;
      activeQuestionRef.current = trimmed;

      // Source authorization gate: explicit-web may discover immediately;
      // vault_then_web requires user escalation; vault is local-only.
      const auth = getDiscoveryAuthorization(prepared);
      setWebEligible(auth !== 'forbidden');
      if (auth === 'enabled') {
        // Explicit web request: skip local vault retrieval entirely.
        setIsExplicitWeb(true);
        setStatus('success');
        await discoverWeb(trimmed, prepared.intent, token);
        return;
      }

      if (!isIntentRuntimeSupported(prepared.intent)) {
        setStatus('error');
        setErrorMsg(RUNTIME_NOT_SUPPORTED_MESSAGE);
        return;
      }

      // B) Deterministic Stage A: build the bounded candidate evidence set.
      setStatus('searching');
      const index = buildRecipeRelationshipIndex(allRecipes);
      const candidates = buildKitchenCandidates(prepared.intent, allRecipes, prepared.trustedContext, { index });
      const candidateIdSet = new Set(candidates.map((c) => c.recipeId));

      // Stage B: optional AI ranking over the SAME candidate set, with a
      // deterministic fallback. Ranking is advisory only — final membership and
      // the visible per-recipe explanation remain deterministic and grounded.
      setStatus('answering');
      const { selected, source } = await rankKitchenCandidates(prepared.intent, candidates, prepared.trustedContext, {
        index,
        question: trimmed,
        aiRank: async (input) => {
          const rankRes = await fetch('/api/kitchen/rank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRankRequest(input.question, input.intent, input.candidates, input.resultCount)),
          });
          const rankData = await rankRes.json().catch(() => null);
          if (tokenRef.current !== token) return null;
          if (!rankRes.ok || !rankData || rankData.ok !== true) return null;
          return sanitizeAiRankedCandidates(rankData, candidateIdSet, {
            maxResults: input.resultCount,
          }) ?? null;
        },
      });
      if (tokenRef.current !== token) return;

      // C) Build a grounded answer from the SELECTED candidates + evidence.
      const answer = buildGroundedKitchenAnswer(selected, candidates, { source });
      setAnswer(answer);
      setStatus(answer.noMatches ? 'noMatches' : 'success');

      // D) Offer-only web discovery for vault_then_web when local results are weak.
      const localCount = selected.length;
      const offer = canOfferWebDiscovery(prepared, localCount);
      setShowWebOffer(offer);
      setWebStatus(offer ? 'offering' : 'idle');
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
                  {webEligible ? 'Vault-first · optional web' : 'Your Vault Only'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                Ask a question and I&apos;ll search your vault first, and may offer to search the web if needed.
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
              <span>{progressLabel(status, webStatus)}</span>
            </div>
          )}

          {/* Error */}
          {status === 'error' && errorMsg && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* From My Vault */}
          {!isExplicitWeb && (status === 'noMatches' || status === 'success') && answer && (
            <div className="space-y-4">
              <SectionHeading>From My Vault</SectionHeading>
              <p className="text-sm text-gray-200">{answer.summary}</p>
              {status === 'noMatches' ? (
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
              ) : (
                <ul className="space-y-2">
                  {answer.items.map((item) => renderAnswerItem(item, allRecipes, handleSelectRecipe))}
                </ul>
              )}
            </div>
          )}

          {/* Vault_then_web: offer-only escalation */}
          {!isExplicitWeb && showWebOffer && webStatus === 'offering' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">
                Not seeing what you&apos;re after in your vault. Want me to look online?
              </p>
              <button
                id="ask-my-kitchen-offer-web"
                onClick={handleOfferWeb}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25"
              >
                <Search className="w-3.5 h-3.5" />
                Search the web
              </button>
            </div>
          )}

          {/* From The Web */}
          {webStatus === 'done' && webResults.length > 0 && (
            <div className="space-y-4">
              <SectionHeading>From The Web</SectionHeading>
              <ul className="space-y-2">
                {webResults.map((item) => renderWebResultCard(item))}
              </ul>
            </div>
          )}

          {/* Web discovery unavailable / explicit-web note */}
          {webStatus === 'unavailable' && (
            <div className="flex items-start gap-2 text-xs text-gray-400 bg-[#0C0C0C] border border-white/5 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400/70" />
              <span>
                {isExplicitWeb
                  ? "Web search isn't available right now, so there are no online results to show."
                  : "Web search isn't available right now."}
              </span>
            </div>
          )}

          {/* Idle hint */}
          {status === 'idle' && (
            <div className="flex items-start gap-2.5 text-xs text-gray-500 bg-[#0C0C0C] border border-white/5 rounded-xl px-4 py-3">
              <BookOpen className="w-4 h-4 shrink-0 mt-0.5 text-amber-400/70" />
              <p>
                I search your vault first. Try &quot;what can I make with chicken and rice?&quot;,
                &quot;what desserts take under 30 minutes?&quot;, or &quot;Find me a gumbo recipe
                online.&quot; — I only ever search the web when you ask me to.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
