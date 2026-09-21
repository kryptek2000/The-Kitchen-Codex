import React from 'react';

/**
 * The Kitchen Codex — Brand source of truth.
 *
 * The mark is a faithful vector reconstruction of the approved Kitchen Codex
 * artwork (deep stock pot with a curled rim, outward loop handles, a tilted lid,
 * and flowing steam that becomes circuit traces with round/square terminals).
 * It is the ONLY place the brand silhouette is defined — the header, theme
 * picker, and favicon all derive from it.
 *
 * COLORING (dynamic, token-driven — no hard-coded theme hexes here):
 *   - the vessel/lid/circuit use `currentColor`, pinned by `.kc-brand-mark__body`
 *     to `var(--text-primary)`, so they stay readable on every theme;
 *   - the steam uses `.kc-brand-mark__accent` → `var(--accent-text)` (falling
 *     back to `var(--accent)`), so Blood Moon's crimson shows up automatically.
 *
 * TWO LEVELS OF THE SAME IDENTITY:
 *   - `variant="full"`    — the complete mark (header, banner, large contexts)
 *   - `variant="compact"` — pot + lid + steam only (favicon / tiny contexts)
 * The compact mark is a strict subset of the full artwork, so both are
 * unmistakably the same logo.
 */

const FULL_STEAM: string[] = [
  'M664 82 672 84 682 96 682 116 668 130 660 114 666 104 666 98 660 90 664 82Z',
  'M462 88 478 96 492 112 500 130 504 150 502 180 496 200 470 242 460 232 470 222 486 192 492 172 492 140 484 114 480 112 476 102 466 92 462 92 462 88Z',
  'M600 176 604 178 606 214 602 220 606 226 604 274 598 296 588 314 560 340 536 352 512 358 482 372 454 378 428 392 392 428 374 470 372 500 386 544 390 546 394 558 404 568 408 578 458 622 484 664 490 686 490 712 484 728 476 734 478 694 472 674 456 648 436 628 432 628 416 614 376 596 374 592 366 590 350 576 346 576 328 558 328 554 318 546 318 542 306 528 296 506 288 476 290 426 298 400 328 350 358 320 398 294 404 286 410 286 416 292 416 296 412 296 406 304 366 330 360 340 346 352 346 356 328 378 314 406 306 434 304 466 314 506 332 536 360 564 366 566 600 176Z M560 180 570 196 572 220 564 254 550 278 518 308 514 308 494 324 468 336 466 340 458 342 420 372 446 358 470 350 502 346 536 334 556 322 574 304 584 286 588 268 588 180 594 180 560 180Z M524 206 530 206 530 222 538 226 534 240 516 272 528 266 542 252 542 248 554 234 562 212 562 208 524 206Z',
  'M718 178 724 180 720 190 716 190 714 186 718 178Z',
  'M472 588 476 598 484 606 498 610 524 632 536 654 540 672 538 700 532 716 520 732 518 728 526 716 530 698 528 670 518 650 500 632 482 624 472 614 472 588Z',
];

const FULL_BODY: string[] = [
  'M404 40 450 40 452 86 436 86 436 258 458 238 458 234 468 240 466 248 456 256 456 260 418 294 408 286 414 278 418 278 418 86 404 86 404 40Z',
  'M510 40 556 40 556 86 542 86 542 208 538 224 530 222 530 206 524 206 526 188 530 188 530 182 526 182 526 164 530 164 530 158 526 158 526 140 530 140 530 134 526 134 526 116 530 116 530 110 526 110 524 100 526 88 510 86 510 40Z',
  'M700 40 748 40 748 86 732 88 732 158 726 178 716 180 716 196 698 214 676 226 662 230 606 230 602 222 606 214 656 214 686 202 702 186 712 168 716 150 716 88 700 86 700 40Z',
  'M650 80 664 80 660 90 666 98 666 104 660 114 666 122 666 130 642 130 618 156 614 156 606 164 604 178 600 176 596 180 588 180 590 156 600 150 632 118 632 94 638 86 650 80Z',
  'M768 40 816 40 816 86 800 86 800 142 900 240 904 270 894 304 872 328 864 330 858 336 834 342 622 342 554 410 556 432 552 440 536 450 518 448 510 442 504 430 504 416 508 408 522 398 542 400 618 324 840 324 860 316 880 294 886 276 884 246 782 146 782 86 768 86 768 40Z',
  'M304 74 322 74 336 86 338 108 334 116 316 126 300 122 264 160 232 162 204 190 204 380 220 380 220 426 172 426 172 380 188 380 188 208 144 252 138 254 138 426 206 490 206 494 192 502 120 430 120 250 224 146 256 144 288 112 288 88 296 78 304 74Z',
  'M874 94 894 94 908 106 908 132 940 162 956 190 964 214 968 240 968 318 962 342 946 370 922 392 902 402 876 408 654 408 654 422 608 422 608 376 654 376 654 390 882 390 912 378 934 358 950 322 948 220 942 200 924 168 896 142 882 146 870 142 862 134 858 126 858 112 862 104 874 94Z',
  'M338 150 384 150 384 196 338 196 268 266 268 538 280 572 310 610 314 610 320 618 340 628 342 632 392 652 424 678 442 708 444 728 428 710 428 706 396 676 366 658 360 658 322 640 302 622 298 622 270 588 254 552 142 550 70 478 56 448 56 318 42 308 38 300 38 286 50 270 62 266 74 268 86 278 90 286 90 300 86 308 72 318 72 444 80 464 150 534 252 534 250 260 338 174 338 150Z',
  'M770 224 818 224 818 270 770 270 770 224Z',
  'M620 270 716 270 716 286 620 286 620 270Z',
  'M1014 294 1032 294 1042 300 1048 310 1050 324 1046 334 1032 344 1032 374 1024 404 1006 434 986 454 958 470 944 474 860 476 860 492 814 492 814 444 860 444 860 460 930 460 952 454 976 440 994 422 1012 386 1016 362 1014 344 1008 342 998 330 996 314 1000 304 1014 294Z',
  'M682 450 702 450 732 458 762 472 784 492 796 520 794 548 824 564 826 568 848 580 852 586 856 586 860 592 864 592 870 600 874 600 886 614 890 614 898 622 898 626 914 640 914 644 930 662 944 698 944 716 938 724 926 728 872 714 688 650 650 632 624 624 616 618 610 618 602 612 596 612 566 596 560 596 536 582 530 582 414 522 408 510 410 498 426 484 450 474 494 466 540 466 600 474 636 484 640 474 654 460 682 450Z M686 486 674 490 674 496 692 500 754 528 760 528 756 514 744 502 704 486 686 486Z M496 502 468 506 466 510 566 560 572 560 602 576 608 576 644 594 650 594 724 626 736 628 740 632 844 668 898 682 888 664 874 652 874 648 824 606 788 586 786 582 718 548 652 524 598 510 542 502 496 502Z',
  'M240 722 286 734 326 740 458 750 606 750 710 744 774 736 832 722 842 726 848 734 848 828 858 828 888 818 872 816 862 804 866 786 878 780 904 780 928 788 940 800 942 818 938 828 916 846 892 856 848 866 848 982 840 1030 828 1062 824 1064 818 1078 798 1100 788 1104 784 1110 732 1130 662 1140 448 1142 370 1136 330 1128 298 1116 276 1102 258 1084 238 1048 226 1000 224 866 194 860 150 842 134 828 130 818 132 802 142 790 160 782 192 780 206 786 210 804 200 816 182 818 214 828 224 828 224 734 230 726 240 722Z M262 764 262 998 268 1026 280 1054 306 1080 340 1094 408 1104 666 1104 712 1098 744 1090 768 1078 792 1052 804 1024 812 972 812 764 730 778 612 786 416 784 326 776 262 764Z',
];

const COMPACT_STEAM: string[] = [
  'M664 82 672 84 682 96 682 116 668 130 660 114 666 104 666 98 660 90 664 82Z',
  'M462 88 478 96 492 112 500 130 504 150 502 180 496 200 470 242 460 232 470 222 486 192 492 172 492 140 484 114 480 112 476 102 466 92 462 92 462 88Z',
  'M600 176 604 178 606 214 602 220 606 226 604 274 598 296 588 314 560 340 536 352 512 358 482 372 454 378 428 392 392 428 374 470 372 500 386 544 390 546 394 558 404 568 408 578 458 622 484 664 490 686 490 712 484 728 476 734 478 694 472 674 456 648 436 628 432 628 416 614 376 596 374 592 366 590 350 576 346 576 328 558 328 554 318 546 318 542 306 528 296 506 288 476 290 426 298 400 328 350 358 320 398 294 404 286 410 286 416 292 416 296 412 296 406 304 366 330 360 340 346 352 346 356 328 378 314 406 306 434 304 466 314 506 332 536 360 564 366 566 600 176Z M560 180 570 196 572 220 564 254 550 278 518 308 514 308 494 324 468 336 466 340 458 342 420 372 446 358 470 350 502 346 536 334 556 322 574 304 584 286 588 268 588 180 594 180 560 180Z M524 206 530 206 530 222 538 226 534 240 516 272 528 266 542 252 542 248 554 234 562 212 562 208 524 206Z',
  'M718 178 724 180 720 190 716 190 714 186 718 178Z',
  'M472 588 476 598 484 606 498 610 524 632 536 654 540 672 538 700 532 716 520 732 518 728 526 716 530 698 528 670 518 650 500 632 482 624 472 614 472 588Z',
];

const COMPACT_BODY: string[] = [
  'M682 450 702 450 732 458 762 472 784 492 796 520 794 548 824 564 826 568 848 580 852 586 856 586 860 592 864 592 870 600 874 600 886 614 890 614 898 622 898 626 914 640 914 644 930 662 944 698 944 716 938 724 926 728 872 714 688 650 650 632 624 624 616 618 610 618 602 612 596 612 566 596 560 596 536 582 530 582 414 522 408 510 410 498 426 484 450 474 494 466 540 466 600 474 636 484 640 474 654 460 682 450Z M686 486 674 490 674 496 692 500 754 528 760 528 756 514 744 502 704 486 686 486Z M496 502 468 506 466 510 566 560 572 560 602 576 608 576 644 594 650 594 724 626 736 628 740 632 844 668 898 682 888 664 874 652 874 648 824 606 788 586 786 582 718 548 652 524 598 510 542 502 496 502Z',
  'M240 722 286 734 326 740 458 750 606 750 710 744 774 736 832 722 842 726 848 734 848 828 858 828 888 818 872 816 862 804 866 786 878 780 904 780 928 788 940 800 942 818 938 828 916 846 892 856 848 866 848 982 840 1030 828 1062 824 1064 818 1078 798 1100 788 1104 784 1110 732 1130 662 1140 448 1142 370 1136 330 1128 298 1116 276 1102 258 1084 238 1048 226 1000 224 866 194 860 150 842 134 828 130 818 132 802 142 790 160 782 192 780 206 786 210 804 200 816 182 818 214 828 224 828 224 734 230 726 240 722Z M262 764 262 998 268 1026 280 1054 306 1080 340 1094 408 1104 666 1104 712 1098 744 1090 768 1078 792 1052 804 1024 812 972 812 764 730 778 612 786 416 784 326 776 262 764Z',
];

export type KitchenCodexMarkVariant = 'full' | 'compact';

export interface KitchenCodexMarkProps {
  /** Rendered size in px (square box). Defaults to 40. */
  size?: number;
  /** `full` (default) or `compact` (pot + lid + steam only). */
  variant?: KitchenCodexMarkVariant;
  className?: string;
  /** Accessible label. Ignored when `decorative` is true. */
  title?: string;
  /** Mark as presentational (e.g. when a visible wordmark already labels it). */
  decorative?: boolean;
}

export function KitchenCodexMark({
  size = 40,
  variant = 'full',
  className = '',
  title = 'The Kitchen Codex',
  decorative = false,
}: KitchenCodexMarkProps) {
  const a11y = decorative
    ? { 'aria-hidden': true as const, focusable: false as const }
    : { role: 'img' as const, 'aria-label': title };

  const steam = variant === 'compact' ? COMPACT_STEAM : FULL_STEAM;
  const body = variant === 'compact' ? COMPACT_BODY : FULL_BODY;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1088 1180"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...a11y}
    >
      <g className="kc-brand-mark__accent" fill="currentColor" fillRule="evenodd">
        {steam.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g className="kc-brand-mark__body" fill="currentColor" fillRule="evenodd">
        {body.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

export interface KitchenCodexWordmarkProps {
  className?: string;
  /** Optional secondary line under the wordmark. */
  tagline?: string;
  as?: 'span' | 'div' | 'h1' | 'h2';
}

export function KitchenCodexWordmark({
  className = '',
  tagline,
  as: Tag = 'span',
}: KitchenCodexWordmarkProps) {
  return (
    <Tag className={`inline-flex flex-col leading-tight ${className}`}>
      <span className="kc-brand-wordmark font-serif font-bold tracking-tight">
        The Kitchen Codex
      </span>
      {tagline ? (
        <span className="text-[10px] uppercase tracking-widest text-gray-500">{tagline}</span>
      ) : null}
    </Tag>
  );
}

export type KitchenCodexBrandSize = 'sm' | 'md' | 'lg';

export interface KitchenCodexBrandProps {
  /**
   * `full` = mark + wordmark (+ optional tagline/badge); `icon` = mark only.
   * Use `icon` in narrow layouts where a wordmark would crowd controls.
   */
  variant?: 'full' | 'icon';
  size?: KitchenCodexBrandSize;
  className?: string;
  tagline?: string;
  /** Small secondary descriptor (e.g. "Developer's Edition"). Descriptive only. */
  badge?: string;
  /** Visually hide the wordmark below the `sm` breakpoint. */
  responsiveWordmark?: boolean;
}

const BRAND_SIZES: Record<KitchenCodexBrandSize, { mark: number; title: string }> = {
  sm: { mark: 30, title: 'text-sm' },
  md: { mark: 44, title: 'text-lg' },
  lg: { mark: 60, title: 'text-xl' },
};

/**
 * Brand lockup matching the approved horizontal layout: the bare mark anchors
 * the left, the wordmark sits to its right. No filled tile — the reference
 * horizontal lockup places the mark directly on the surface.
 */
export function KitchenCodexBrand({
  variant = 'full',
  size = 'md',
  className = '',
  tagline,
  badge,
  responsiveWordmark = false,
}: KitchenCodexBrandProps) {
  const s = BRAND_SIZES[size];
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <KitchenCodexMark size={s.mark} decorative className="shrink-0" />
      {variant === 'full' ? (
        <div
          className={`flex flex-col leading-tight min-w-0 ${
            responsiveWordmark ? 'hidden sm:flex' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`kc-brand-wordmark font-serif font-bold tracking-tight ${s.title}`}>
              The Kitchen Codex
            </span>
            {badge ? (
              <span className="kc-brand-badge text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded border font-medium">
                {badge}
              </span>
            ) : null}
          </div>
          {tagline ? (
            <span className="text-xs text-gray-500 truncate">{tagline}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
