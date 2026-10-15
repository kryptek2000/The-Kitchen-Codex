# SHISO — Official Mascot and Animated Companion Gameplan

**Decision owner:** Sid Richmond (sole release/deployment authority)  
**Approved:** October 14, 2026  
**Product:** The Kitchen Codex  
**Status:** Brand identity approved; website static introduction published; app animation still research/planning only  
**Relationship:** Companion to [Shiso Architecture and Roadmap](Shiso-Architecture-and-Roadmap.md), not a replacement for its conversation, nutrition, and product-capability phases.

## Decision

**SHISO is the official AI companion AND official mascot of The Kitchen Codex.**

Sid approved the original AI-generated visual concept depicting a leaf-hooded, floating, charcoal-black culinary helper with soft green illuminated eyes, gold trim, and a friendly, expressive face. SHISO should be a signature character of the product without displacing the Kitchen Codex brand, approved app logo, or Vault identity.

The approved **visual concept** is shown below. The linked image is a web-optimized derivative; the original high-resolution generated artwork should remain a preserved brand master for later animation work.

![SHISO official mascot — approved visual direction](https://raw.githubusercontent.com/kryptek2000/The-Kitchen-Codex-Website/design/shiso-official-mascot-20261014/assets/shiso-official-mascot.webp)

### Visual signature

- Compact, floating AI companion; premium dark graphite/charcoal finish and reflective black faceplate.
- Layered shiso-leaf hood with subtle veins and green-to-purple botanical accents.
- Expressive glowing green eyes, small friendly mouth, restrained warm-gold metal accents and leaf emblem.
- Feels intelligent, approachable, playful and distinctly culinary — **not** a generic robot or a cartoon chef.
- Use the existing Kitchen Codex green, ink and warm-cream aesthetic; the mascot may glow more brightly **inside its own artwork**, never override application readability.

## Planned phases and explicit gates

| Phase | Status | Product deliverable | Exit gate |
| --- | --- | --- | --- |
| **M0 — Mascot Identity** | **APPROVED** | Canonical character concept, visual direction, brand ownership and master-source preservation | Sid's approval, October 14 |
| **M1 — Static Introduction** | **PUBLISHED ON WEBSITE** | Web-optimized mascot in the website's existing Meet Shiso section; optional static character placement in the app chat once separately approved | Site/UX review, truthful copy, static accessibility, signed-off release |
| **M2 — Animated Chat Companion** | **PLANNED** | State-driven lightweight avatar in the *one* SHISO conversation UI: idle, thinking, investigating, responding, success, clarification/error | SHISO functionality, reliability and latency meet human acceptance; no performance regression |
| **M3 — Website Motion** | **PLANNED** | Optional subtle floating/blinking or state vignettes on the site, static fallback by default | Responsive/accessibility/performance review; Sid's website release approval |
| **M4 — Full Mascot System** | **FUTURE** | Expression/pose library, onboarding, help, cooking-mode reactions, marketing assets and optional voice | Capability truth, performance, and separate product approvals |

### M2 interaction and animation contract

SHISO is an interface representation of **real state**, not fake activity:

- **Idle:** calm breathing/occasional blink when ready.
- **Thinking:** restrained pulse after a user submits a turn; never imply tool activity that is not occurring.
- **Investigating:** purposeful scan cues only while a verified USDA/application tool is executing.
- **Responding:** subtle expression change while results are actually delivered.
- **Success:** brief low-key reaction when an operation is confirmed by the authoritative app, not merely proposed by AI.
- **Clarification / error:** recognizable still or curious state without alarming flashing or misleading success.

Prefer CSS transforms and a handful of optimized static/vector frames instead of heavyweight looping video. Always respect `prefers-reduced-motion`; provide a static fallback, descriptive labeling where semantically useful, and no flashing. Pause motion when the chat is hidden or offscreen. Avoid invasive attention cues.

**Performance is a release gate.** Animation must not slow SHISO investigation, compete with USDA processing on Sid's hardware, block keyboard/chat interaction, or meaningfully increase CPU/memory. Measure real input latency, rendering cost, page weight and reduced-motion handling on desktop and mobile before launch.


### M2 research addendum — original stateful companion motion (October 15, 2026)

**Source of visual inspiration:** Sid supplied an earlier Muse UI screen recording and three distinct eight-second, 24-fps animation clips: a relaxed idle pose, a working pose at a laptop, and a milestone celebration. The duplicate milestone filename shows the same celebration. The clips are design references only, not assets or character-design templates to reuse.

**Observed in the clips:**
- **Idle:** tiny head and gaze changes make the character feel present without dominating the interface.
- **Working:** a clearly distinct scene and purposeful action (typing at a laptop) makes progress visible without explanatory words.
- **Milestone:** a one-shot transition from ordinary posture to a cape-and-star celebration, followed by a held triumph pose; the contrast makes it feel special.
- **Avoid copying:** Muse's white-metal robot, cyan color scheme, laptop/cape/star props, and white-background full-body video presentation are not SHISO's identity.

**Outside research:** [Meta's Muse Realtime Avatar work](https://research.meta.ai/blog/bringing-your-muse-to-life) documents voice-conditioned, continuously generated synchronized animation; that infrastructure is unnecessary for SHISO's text-first experience. [Rive's state machines](https://github.com/rive-app/help-center/blob/master/runtimes/state-machines.md) and [React runtime](https://github.com/rive-app/rive-react) could provide local, event-driven character transitions, but are evaluation options, not approved dependencies. [Reduced-motion guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion) is a required accessibility baseline.

#### SHISO animation language: "The Living Leaf"

Preserve the approved charcoal faceplate, glowing green eyes, layered shiso-leaf hood, faint purple accents, and restrained gold metalwork. SHISO's movement vocabulary should use expressive leaves, a tiny Codex book, verified recipe cards, and warm-gold accents.

| State | Signature gesture | Grounded application trigger |
| --- | --- | --- |
| **Idle** | Subtle floating, infrequent blink, a little leaf-tip sway and curious gaze. | Conversation ready, no active operation. |
| **Listening** | Tilts toward the composer; eyes focus on incoming input. | Focus/input present; no pretend audio capture. |
| **Thinking** | Quiet leaf-vein glow and a restrained eye shift. | A genuinely pending provider turn. |
| **Investigating** | A translucent recipe card unfolds and SHISO follows it with its eyes. | Real authenticated search/investigation tool running. |
| **Editing** | A leaf-quill traces a short mark on a card; tiny nod after verified working-copy edit. | Application confirms working-state change, NOT model text. |
| **Calculating** | Ingredients briefly orbit a miniature kitchen scale, then settle. | Genuine deterministic nutrition calculation in progress. |
| **Responding** | Eyes brighten; slight smile and hover settle as words appear. | Assistant reply being delivered, no fake lip-sync. |
| **Needs clarification** | Curious tilt and soft expression, no sad loop. | App has a real unresolved choice or missing measurement. |
| **Error/cancelled** | Leaf glow dims to calm neutral; stays readable and non-alarming. | Verified failed, stale, cancelled or denied operation. |
| **Confirmed unsaved edit** | Small gold glint on the change card, but no Vault-save seal. | Working-copy mutation confirmed; still unsaved. |
| **Saved** | One small leaf-seal stamp and warm glow. | Canonical Vault write confirmed successful. |
| **Milestone: Codex Bloom** | Signature one-shot: shiso leaves open like a canopy, a miniature Codex book unfolds, four or five gold leaf-sparks form a constellation, and SHISO beams. | App-confirmed meaningful milestone only; never on an ordinary model answer. |

**Milestone discipline:** Potential examples for a later product decision include the user's first successfully saved recipe or first completed weekly plan. Do not invent XP, scores, streaks, badges or progress systems. An explicit user-triggered celebration can be considered, but must not distract from cooking or editing. No celebration for provider text that falsely claims success, failed saves, or partial/unverified nutrition.

#### Placement and sequence

- **Chat closed:** static SHISO entry icon, no continuous global animation.
- **Chat opened / empty conversation:** medium SHISO portrait (proposed 120–160 CSS px); one gentle idle motion.
- **During messages:** compact portrait (proposed 40–64 CSS px) beside header/status; actions, review rows and conversation remain primary.
- **Milestone:** brief non-blocking 3–5 second optional expanded vignette; never obscures recipe controls, review, undo, or Save.
- **Mobile:** compact or static fallback in constrained viewports.

#### Authority, performance and implementation approach

The avatar **reads** existing UI/application events and performs no provider, USDA, filesystem or Vault operations. Bind to real events such as a submitted turn, provider response, tool start/end, working recipe update, nutrition preview ready, confirmed Vault save success/failure, clarification and cancellation. Event identifiers above are descriptive, not a demand to create new business-event infrastructure.

A reported model success is **never** an animation success signal. Error and cancellation override success; a short transition prevents flicker between closely spaced tools. A pending edit is not a saved edit. Stop working motion when the operation ends, even when an AI response times out.

**M2A — design/rig:** Create a coherent lightweight original SHISO part/expression sheet from approved artwork (faceplate, eyes, mouth, hood, body, leaf, recipe card/book). Preserve the original approved image as brand master. Ensure an attractive static fallback.

**M2B — offline animation prototype:** Start with CSS opacity/transform for idle, thinking and respond, using existing motion utilities where practical. Compare with a Rive state machine only after testing actual asset weight and smoothness. No heavyweight always-playing MP4 loops or AI video-generation service required.

**M2C — trusted event integration:** Once H-2 editing authority is independently audited and Sid accepts the real workflows, connect the display-only animation adapter to the existing SHISO chat/tool/edit/calculate/save results. Stub UI events in tests; no live Gemini calls required for animation tests.

**M2D — Codex Bloom:** Add the signature celebration after everyday transitions are robust. Make it rare, optional, instantly interruptible, and honest about milestones.

**Quality gates:** Animation cannot add a second SHISO runtime or change nutrition/edit authority, block keyboard or touch input, steal rendering resources from USDA/tool work, or increase interaction latency noticeably. Pause or unmount while chat/tab is hidden. Honor reduced motion with meaningful static state representations. Avoid rapid flashing. Measure CPU, memory, initial asset size, input latency and motion smoothness on modest hardware before release; do not assert unmeasured budget success.

**Governance:** This is research and design documentation only, added to the existing draft PR #8; not a shipping implementation. Do not merge into main or touch Sid's local uncommitted H-2 work until explicit release approval.


### Architecture and truth constraints

- SHISO remains *one* AI companion / conversation system with multiple contextual entry points. Do not build a second mascot chatbot, API provider stack, tool runner, memory store, nutrition engine, or credential path.
- Animations consume current application state and MUST NOT directly invoke AI, USDA, or Vault operations. The character is a presentation layer, never a new authority.
- The Kitchen Codex validates nutrition against authenticated USDA data and handles user confirmation and Apply. The mascot must not suggest an action completed when it only proposed one.
- Treat image generation, recipe editing, broad Vault operations, meal planning and voice as future/unshipped SHISO capabilities until implemented and verified. The mascot/website should not advertise them as currently available.
- During SHISO H-2 editing-authority audit and Sid's human acceptance tests, prioritize **smart, fast, useful functionality** ahead of mascot animation. Do not interrupt the current uncommitted SHISO implementation.

### Website integration

The mascot was added to the published [Kitchen Codex website](https://kitchencodex.app/). The website repository main branch contains the static artwork and the accurate caption describing SHISO as an AI companion in private testing. It does not advertise a live website chat. The original “The recipes you love deserve a home.” hero, CSS Vault cards, four pillars and Kit signup are preserved. Artwork is a mascot illustration, not a working chat or a literal nutrition result.

See website [Master Plan §22](https://github.com/kryptek2000/The-Kitchen-Codex-Website/blob/design/shiso-official-mascot-20261014/docs/Website-Master-Plan.md) for its approval record and M0–M4 web rollout.

### Governance / app roadmap reconciliation

This file is an **additive plan on a separate review branch**. It intentionally does not overwrite the existing `Shiso-Architecture-and-Roadmap.md` being modified in Bunny's uncommitted H-1 work while Muse audits. After that audit and Sid's authorization, reconcile links and implementation status into the canonical SHISO roadmap. No app implementation or deployment is authorized by this mascot document.

**Release approval:** Sid alone authorizes merging/deployment and accepts the final visual + animation behavior.
