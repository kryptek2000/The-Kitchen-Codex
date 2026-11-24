# C1.7 SHISO Layout Repair — Design QA

## Result

final result: passed

## Visual truth and evidence

- Approved reference: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-LUNA-FLAGSHIP-APPROVED-REFERENCE.png`
- Baseline evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-LAYOUT-REPAIR-BASELINE-DESKTOP.png`
- Final desktop evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-DESKTOP-1586x992.png`
- Final parchment-theme evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-PARCHMENT-1586x992.png`
- Final mobile evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-MOBILE-390x844.png`
- Sidebar inventory evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-SIDEBAR-1586x992.png`
- Working-state evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-WORKING-1586x992.png`
- Native Electron fallback evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-NATIVE-SIDEBAR.png`
- Approved/final side-by-side: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-LAYOUT-REPAIR-COMPARISON-DESKTOP.png`
- Latest proportion-pass desktop: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-PROPORTION-DESKTOP-1586x992.png`
- Latest proportion-pass mobile: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-PROPORTION-MOBILE-390x844.png`
- Latest proportion-pass comparison: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-FINAL-PROPORTION-COMPARISON-DESKTOP.png`
- Acceptance matrix: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-ACCEPTANCE-1680x960.png`, `...1440x900.png`, `...1055x651.png`, `...834x1112.png`, `...390x844.png`, `...320x700.png`
- Final acceptance desktop: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-ACCEPTANCE-FINAL-DESKTOP-1586x992.png`

The approved source and final implementation were compared at the same 1586×992 pixel viewport with device scale factor 1. The side-by-side comparison is 3172×992: approved source on the left and the live implementation on the right. Focused regions were checked for portrait/header, conversation rail, message thread, and composer placement. A 390×844 live mobile viewport was also captured.

## Comparison history

The baseline showed four actionable layout findings:

1. The SHISO portrait was enlarged and vertically cropped, hiding the head/face.
2. The desktop thread was constrained to an oversized centered column instead of using the available main pane.
3. Fixed desktop proportions caused oversized header/control treatment at narrower Electron widths.
4. The workspace lacked a real Back to My Recipe Vault action and several top-nav items were decorative.

The earlier final evidence showed a 400px rail; the latest acceptance evidence shows the portrait fully visible, a 300px track at 1586px, a one-line title, a full-width scrollable thread, a restrained bottom composer, responsive control reductions, a working return-to-vault path, and the removed fake traffic-light/top-right navigation chrome. The final refinement moves Back to My Recipe Vault into the main header beside Create recipe and removes the rail button completely. The original supplied SHISO artwork is intentionally retained. A low-opacity botanical vignette is used only as a theme-aware decorative surface treatment; it is not screenshot proof or a replacement for the supplied avatar.

The latest proportion iteration intentionally refines that composition: the rail is now 300px at 1586px, the main pane is about 1279px, the hero/back block sits in the left rail above Conversations, and the main SHISO header is 142px rather than 192px. This is an efficiency pass, not a new visual direction.

The proportion-pass QA finding was P1/P2-level hierarchy drift: the 400px rail and full-width product bar made the conversation workspace feel secondary, while the 191px SHISO header consumed useful chat height. The fix moved branding/back into the rail, narrowed the rail to 300px, compressed the main header to 142px, and reduced rail/message/composer density. Post-fix evidence is the acceptance matrix, final 1586×992 screenshot, and the 3172×992 approved/reference comparison; no actionable P0/P1/P2 proportion finding remains.

Follow-up alignment review found the compatibility SVG marker was participating in the avatar flex layout and pushing the supplied artwork to the right. The marker remains in the DOM for the existing state/test contract but is now removed from layout with CSS. The recaptured desktop and mobile screenshots show the artwork centered in its frame. Chat with SHISO is grouped once under the existing AI & Companion section, immediately after AI Studio; the separate Create with SHISO sidebar entry is removed and the existing destinations remain present. Back to My Recipe Vault is now a subtle header secondary action beside Create recipe, with a 44px touch target and icon-only narrow/mobile presentations. Message bodies use Plus Jakarta Sans at 15px desktop and 14px mobile; composer input is 15px in both. Fraunces remains reserved for headings/editorial accents.

## Official asset integration

- `shiso-official-portrait.png` (1254×1254) is used for compact/small placements.
- `shiso-official-wave.png` (1122×1402) is used for the normal large idle workspace presentation.
- `shiso-official-thinking.png` (1122×1402) is used for the real thinking/working header and in-flight state.
- `shiso-official-gesture.png` (1122×1402) is used for the large empty-state presentation and alternate full-avatar states.

The large transparent assets use a centered cover crop with `object-position: 50% 18%`; compact UI uses the square portrait centered without the former humanoid scaling transform. The raster artwork retains the glossy black visor highlights, glowing eyes, and botanical leaf hood.

## Final desktop measurements

- Viewport: 1586×992; device scale factor: 1.
- Product bar: removed from the SHISO composition.
- History rail at 1586×992: 300px track; history content width about 299px; hero block is above Conversations and contains no Back control.
- Main pane at 1586×992: x≈301, width≈1279; 81.0% of the application content track.
- Workspace header: x≈301, y≈1, width≈1279, height=142px.
- Portrait: x≈333, y≈25, width=96px, height=96px; `object-position: 50% 18%`; no transform.
- Title: one rendered line at 1586px.
- Thread: x≈301, y≈143, width≈1279, height≈747px; flex scroll region with zero horizontal overflow.
- Composer: x≈319, width≈1243px, height=90px.
- Back control: main-header secondary action, 171.9×44px at 1440/1680; icon-only 44×44px at 1055 and below; transparent background and subdued border/text.

## Responsive and interaction checks

- Native Electron fallback: a real 1920×1080 desktop capture shows the native app window and the reorganized sidebar; the app remained isolated to the disposable profile/Vault.
- Mobile 390×844: history rail collapsed with working expand toggle; latest header x=1, y=117, width=389, height=121; thread x=1, y=238, width=389, height=501; composer x=8, y=739, width=375, height=97; zero overflow.
- Back to My Recipe Vault click: workspace closed and Vault returned to the page view.
- Back to My Recipe Vault Enter/Space activation: passed live; the old rail Back button is absent.
- The removed SHISO top-right navigation has no dead buttons; the main application sidebar remains the navigation source.
- Compact and expand controls: both preserved their existing behavior.
- Obsidian, parchment, nordic, and blood-moon themes: zero horizontal overflow in each live render.
- Latest long-transcript check: scroll content height 1004px, scroll region height 747px, composer bottom 979px against viewport bottom 992px, zero horizontal overflow.
- At 320px, the header uses a 148px two-row action arrangement with Back beside Create recipe, a readable one-line title, and a visible composer.
- Required viewport matrix: 1680×960, 1440×900, 1055×651, 834×1112, 390×844, and 320×700 all reported zero document/body horizontal overflow.
- Back click plus live Enter/Space keyboard activation returned to Vault and restored its active state.
- Existing SHISO S6/S7 live checks: rendered avatar, Stop/progress state, safe Markdown, Signature Recipe Card, four themes, mobile collapse/expand, and clean close all passed.

The simple `hello` reproduction was classified separately from layout: the disposable browser received HTTP 403 from `/api/shiso/turn` with code `NUTRITION_AI_NOT_ENTITLED` and error `AI Advanced Nutrition is not available for this product access.` No provider or entitlement configuration was changed. Because the user entry was retained without an assistant entry, the existing retry warning on reload is expected transcript recovery behavior for this access-gate failure.

## Verification

- Focused Vitest: 6 files, 43 tests passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Full repository `npm test`: not run in this focused pass; NOT VERIFIED.
- Browser text scaling beyond the required CSS viewport matrix: not separately exercised; NOT VERIFIED.

## C1.8 Living Companion Animation QA

- Approved source: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.7-LUNA-FLAGSHIP-APPROVED-REFERENCE.png`
- Implementation evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.8-IDLE-1586x992.png`
- State evidence: `TKC-SHISO-C1.8-THINKING-1586x992.png`, `...WORKING-1586x992.png`, `...SUCCESS-1586x992.png`, `...CANCELLED-1586x992.png`, `...ERROR-1586x992.png`, and `...REDUCED-MOTION-1586x992.png` in the same report directory.
- Motion recording: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.8-IDLE-MOTION-1586x992.mp4`
- Mobile animation evidence: `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.8-IDLE-390x844.png` and `/home/bandit/Documents/Obsidian-Vault/OpenCode Chats/TKC-SHISO-C1.8-IDLE-320x700.png`
- Capture viewport: 1586×992 CSS pixels; device scale factor 1; real Electron renderer through CDP; disposable profile and Vault only.
- Focus: main SHISO avatar/header and progress presentation. The layout, rail, composer, sidebar, Back control, and theme surfaces were treated as protected C1.7 regions.
- Idle measurement: main avatar frame 96×96; computed animation `kc-shiso-idle-float`, 4.2s cycle, observed transform within the intended 3px vertical range.
- Thinking measurement: supplied `shiso-official-thinking.png`, computed `kc-shiso-thinking-float`, 2.8s cycle, real held `/api/shiso/turn` request and visible provider-progress text.
- Working measurement: supplied thinking artwork, computed `kc-shiso-working-settle`, 2.2s cycle, real local `get_current_recipe` tool execution emitted the tool progress step before the next fixture request was held.
- Completion measurement: supplied wave artwork, finite `kc-shiso-success-lift` 0.95s transition, then observed return to idle after 1.3s.
- Error/cancellation measurement: supplied gesture artwork, finite `kc-shiso-cancelled-settle` 0.24s transition; no success state followed.
- Reduced-motion measurement: browser-emulated `prefers-reduced-motion: reduce` produced computed `animation: none`, `animationDuration: 0s`, and `transform: none` while the avatar remained present and labelled.
- Theme evidence: obsidian, parchment, nordic, and blood-moon screenshots captured with the idle animation contract and zero document/body horizontal overflow.
- Limitation: supplied SHISO files are flattened raster illustrations; the implementation animates the complete character and ambient halo only. It does not claim independent blinking, lip, hand, or eye-layer animation.
- Findings: no P0, P1, or P2 design QA findings in the focused C1.8 pass. The flattened-art limitation is an explicit future asset-layer constraint, not a visual defect in this pass.

final result: passed
