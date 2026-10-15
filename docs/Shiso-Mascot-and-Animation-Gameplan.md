# SHISO — Official Mascot and Animated Companion Gameplan

**Decision owner:** Sid Richmond (sole release/deployment authority)  
**Approved:** October 14, 2026  
**Product:** The Kitchen Codex  
**Status:** Brand identity approved; website static introduction in draft review; app animation not implemented  
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
| **M1 — Static Introduction** | **DRAFT WEBSITE REVIEW** | Web-optimized mascot in the website's existing Meet Shiso section; optional static character placement in the app chat once separately approved | Site/UX review, truthful copy, static accessibility, signed-off release |
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

### Architecture and truth constraints

- SHISO remains *one* AI companion / conversation system with multiple contextual entry points. Do not build a second mascot chatbot, API provider stack, tool runner, memory store, nutrition engine, or credential path.
- Animations consume current application state and MUST NOT directly invoke AI, USDA, or Vault operations. The character is a presentation layer, never a new authority.
- The Kitchen Codex validates nutrition against authenticated USDA data and handles user confirmation and Apply. The mascot must not suggest an action completed when it only proposed one.
- Treat image generation, recipe editing, broad Vault operations, meal planning and voice as future/unshipped SHISO capabilities until implemented and verified. The mascot/website should not advertise them as currently available.
- During SHISO H-1 human-test fixes and Muse review, prioritize **smart, fast, useful functionality** ahead of mascot animation. Do not interrupt the current uncommitted SHISO implementation.

### Website integration

The approved October 14 website update is prepared as a **draft PR** in [The Kitchen Codex Website](https://github.com/kryptek2000/The-Kitchen-Codex-Website/pull/1) and is **not deployed**. The original “The recipes you love deserve a home.” hero, CSS Vault cards, four pillars and Kit signup are preserved. Artwork is a mascot illustration, not a working chat or a literal nutrition result.

See website [Master Plan §22](https://github.com/kryptek2000/The-Kitchen-Codex-Website/blob/design/shiso-official-mascot-20261014/docs/Website-Master-Plan.md) for its approval record and M0–M4 web rollout.

### Governance / app roadmap reconciliation

This file is an **additive plan on a separate review branch**. It intentionally does not overwrite the existing `Shiso-Architecture-and-Roadmap.md` being modified in Bunny's uncommitted H-1 work while Muse audits. After that audit and Sid's authorization, reconcile links and implementation status into the canonical SHISO roadmap. No app implementation or deployment is authorized by this mascot document.

**Release approval:** Sid alone authorizes merging/deployment and accepts the final visual + animation behavior.
