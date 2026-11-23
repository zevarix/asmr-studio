# Studio Interface Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the raised equalizer dial appearance across the studio's controls and surfaces.

**Architecture:** Keep native inputs and existing state ownership. Give shared faders explicit amount, pan and crossfader appearances; refine meters and feature surfaces through their existing components. Global styles coordinate buttons, cards, fields and panel hierarchy.

**Tech Stack:** React, TypeScript, CSS/SVG, Vitest and Playwright; no new dependencies.

**Spec:** `docs/interface.md`

## Global Constraints

- Keep existing values, steps, gain scaling, saved recipes and playback behavior.
- Keep horizontal faders and the current responsive content ordering.
- Ordinary fader styling must not affect equalizer inputs or waveform handles.
- Preserve native keyboard/touch interaction, disabled states and accessible labels.
- Use the existing dark green palette, amber focus and system colors in forced-colors mode.
- Keep source, fixtures and documentation free of personal or machine-specific details.

## Review Focus

- Narrow nested controls and long names must fit a 320 px viewport.
- Pan must clearly distinguish left, center and right without changing its numeric scale.
- Native cap dragging and keyboard steps must update the same controlled values.
- Forced-colors and disabled controls must remain readable without gradients.
- Cosmetic updates must not restart audio, change a transition or lose saved settings.

## Task 1: Shared faders

**Files:** `RangeInput.tsx`, a colocated `RangeInput.css`, `LayerControls.tsx`, and `TransitionView.tsx` under `apps/web/src/features/mixer/`.

**Interfaces:** Preserve native range props. Add a presentation variant for amount, pan and crossfader controls; pan also exposes readable left/center/right value text.

- [x] Add the raised cap, recessed track, fill, center marks and accessible states.
- [x] Apply the pan and crossfader variants at their existing call sites.
- [x] Verify actual drag/keyboard values, center crossing, disabled inputs and narrow layouts with relevant existing tests and focused browser checks.

## Task 2: Output meters

**Files:** `apps/web/src/features/mixer/OutputControls.tsx` and `OutputControls.css`.

**Interfaces:** Retain native meters, measured values, held peaks and limiter settings. Decorative segments must derive from the existing reading.

- [x] Refine the meter well, segmentation, scale, peak marker and limiter presentation.
- [x] Verify silence, active levels, full-scale indication, reset and narrow layouts with the existing output tests and rendered checks.

## Task 3: Shared interface finish

**Files:** `apps/web/src/styles.css`, transport markup, and existing feature styles for transitions, timers, movement, occasional playback, loop editing and assistant controls.

**Interfaces:** Use existing classes and states; add only presentation hooks required for clear control states.

- [x] Refine panels, cards, forms, transport and toggles with consistent edge lighting and spacing.
- [x] Carry the same treatment through expanded details, import/export, dialogs and empty states.
- [x] Check populated and empty mixer views, transitions, dialogs and expanded sections at desktop and mobile widths.

## Task 4: Integration and validation

- [x] Run the web tests, workspace typechecking and production build.
- [x] Run the affected UI regression flows in Chromium and WebKit using isolated test data.
- [x] Inspect desktop/mobile screenshots, focus, disabled and forced-colors states; correct material visual issues.
- [x] Self-review the exact combined diff and prepare the verified change for integration.

The accompanying pull request records integration and the resulting canonical revision.
