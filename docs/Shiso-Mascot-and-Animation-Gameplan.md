# SHISO — Official Mascot and Animated Companion Gameplan

**Decision owner:** Sid Richmond (sole release/deployment authority)  
**Approved:** October 14, 2026  
**Product:** The Kitchen Codex  
**Status:** Brand identity approved; website static introduction published; C1.7 flagship workspace and C1.8 state-driven companion animation implemented and merged via [PR #66](https://github.com/kryptek2000/The-Kitchen-Codex/pull/66); advanced expressive animation remains future
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

## Delivered application baseline — C1.7 and C1.8

The approved botanical identity is now integrated into the native SHISO workspace.
Merged [PR #66](https://github.com/kryptek2000/The-Kitchen-Codex/pull/66) delivers
the flagship conversation workspace and the first living-companion motion layer
on `main` at merge commit `e0b309e545875a16397773c2d9c0fbd6e3bcaa4e`.

The delivered baseline includes:

- C1.7 flagship workspace: one authoritative conversation presentation shared by
  compact and full-page views, conversation history controls, responsive layout,
  anchored composer, approved SHISO artwork, and the existing explicit
  Save-to-Vault authority.
- C1.8 state-driven character presentation in the existing SHISO lifecycle:
  `idle`, `thinking`, `working`, `success`, and `cancelled` states. The mapping
  is presentational and is driven by actual request/tool/error/completion state;
  it does not invent provider activity or speech.
- CSS whole-character/ambient motion for the supplied flattened artwork, with
  reduced-motion handling. Compact history/navigation avatars remain static.
- Focused lifecycle and reduced-motion coverage in
  `tests/unit/shisoC18Animation.test.tsx`; the merged PR's final CI was green.

The flattened raster artwork is not treated as independently addressable eyes,
mouth or limbs. Advanced facial animation, richer expression/pose layers,
Codex Bloom, voice synchronization, and expanded character interactions remain
future work.

## Planned phases and explicit gates

| Phase | Status | Product deliverable | Exit gate |
| --- | --- | --- | --- |
| **M0 — Mascot Identity** | **APPROVED** | Canonical character concept, visual direction, brand ownership and master-source preservation | Sid's approval, October 14 |
| **M1 — Static Introduction** | **PUBLISHED ON WEBSITE** | Web-optimized mascot in the website's existing Meet Shiso section; optional static character placement in the app chat once separately approved | Site/UX review, truthful copy, static accessibility, signed-off release |
| **M2 — Animated Chat Companion** | **IMPLEMENTED — C1.8 baseline** | State-driven lightweight avatar in the *one* SHISO conversation UI: idle, thinking, working, success, cancelled, with reduced-motion fallback | Merged PR #66 and green CI establish the delivered baseline; advanced expressive states and owner acceptance remain separate |
| **M3 — Website Motion** | **PLANNED** | Optional subtle floating/blinking or state vignettes on the site, static fallback by default | Responsive/accessibility/performance review; Sid's website release approval |
| **M4 — Full Mascot System** | **FUTURE** | Expression/pose library, onboarding, help, cooking-mode reactions, marketing assets and optional voice | Capability truth, performance, and separate product approvals |

### M2 interaction and animation contract — delivered baseline plus future extensions

SHISO is an interface representation of **real state**, not fake activity:

- **Delivered idle:** gentle whole-character presence while the conversation is ready.
- **Delivered thinking/working:** restrained activity after a real turn begins; working is distinguished by an actual tool-progress step and never by an artificial timer.
- **Delivered success/cancelled:** brief completion or calm error/cancellation presentation, with no success animation after failure.
- **Future extensions:** richer investigating/responding/clarification poses, facial expression layers and Codex Bloom remain future; no current state claims speech or lip synchronization.

Prefer CSS transforms and a handful of optimized static/vector frames instead of heavyweight looping video. Always respect `prefers-reduced-motion`; provide a static fallback, descriptive labeling where semantically useful, and no flashing. Pause motion when the chat is hidden or offscreen. Avoid invasive attention cues.

**Performance remains a release gate for future extensions.** The delivered
baseline uses CSS transforms/opacity and existing application state; it must not
slow SHISO investigation, compete with USDA processing, block keyboard/chat
interaction, or imply unverified provider activity. Measure additional input
latency, rendering cost, page weight and reduced-motion handling before adding
new character systems.


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

**M2A — delivered static foundation / future rig:** The approved supplied raster
artwork and static fallbacks are integrated. A layered face/expression sheet
from the preserved brand master remains future work; the current flattened
assets are not presented as independently animatable parts.

**M2B — implemented:** CSS opacity/transform motion covers the delivered idle,
thinking/working, success and cancelled states using the existing SHISO artwork.
No heavyweight always-playing MP4 loop or AI video-generation service was added.

**M2C — implemented baseline:** The display-only animation adapter reads the
existing SHISO chat/tool/error/completion lifecycle and does not invoke AI,
USDA, filesystem or Vault operations. The implementation and tests use
deterministic fixtures; no live provider acceptance is claimed.

**M2D — Codex Bloom:** Add the signature celebration after everyday transitions are robust. Make it rare, optional, instantly interruptible, and honest about milestones.

**Quality gates:** Animation cannot add a second SHISO runtime or change nutrition/edit authority, block keyboard or touch input, steal rendering resources from USDA/tool work, or increase interaction latency noticeably. Pause or unmount while chat/tab is hidden. Honor reduced motion with meaningful static state representations. Avoid rapid flashing. Measure CPU, memory, initial asset size, input latency and motion smoothness on modest hardware before release; do not assert unmeasured budget success.

**Governance:** This document preserves the original research and design history
while recording the delivered C1.7/C1.8 baseline. It is not authority to add
new capabilities, change application behavior, use a live provider, or deploy.
Future animation work still requires separate implementation, verification and
release approval.


### Architecture and truth constraints

- SHISO remains *one* AI companion / conversation system with multiple contextual entry points. Do not build a second mascot chatbot, API provider stack, tool runner, memory store, nutrition engine, or credential path.
- Animations consume current application state and MUST NOT directly invoke AI, USDA, or Vault operations. The character is a presentation layer, never a new authority.
- The Kitchen Codex validates nutrition against authenticated USDA data and handles user confirmation and Apply. The mascot must not suggest an action completed when it only proposed one.
- Treat advanced expressive character interactions, Codex Bloom, image generation, broad Vault operations, meal planning and voice synchronization as future/unshipped SHISO capabilities until separately implemented and verified. The mascot/website should not advertise them as currently available.
- During SHISO H-2 editing-authority audit and Sid's human acceptance tests, prioritize **smart, fast, useful functionality** ahead of mascot animation. Do not interrupt the current uncommitted SHISO implementation.

### Website integration

The mascot was added to the published [Kitchen Codex website](https://kitchencodex.app/). The website repository main branch contains the static artwork and the accurate caption describing SHISO as an AI companion in private testing. It does not advertise a live website chat. The original “The recipes you love deserve a home.” hero, CSS Vault cards, four pillars and Kit signup are preserved. Artwork is a mascot illustration, not a working chat or a literal nutrition result.

See website [Master Plan §22](https://github.com/kryptek2000/The-Kitchen-Codex-Website/blob/design/shiso-official-mascot-20261014/docs/Website-Master-Plan.md) for its approval record and M0–M4 web rollout.

### Governance / app roadmap reconciliation

This file is an **additive plan and reconciliation record for documentation PR
#8**. It preserves the historical design decisions and links the delivered
C1.7/C1.8 baseline to the canonical SHISO roadmap. No app implementation,
provider call or deployment is authorized by this mascot document.

**Release approval:** Sid alone authorizes merging/deployment and accepts the final visual + animation behavior.
