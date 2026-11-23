# Studio interface

The interface uses a dark green studio palette. Raised controls sit above recessed
tracks and quiet panels; the strongest emphasis belongs to the current action or
setting. The equalizer's shaded dials establish the material and lighting for the
rest of the controls.

## Controls

- Volume and other amount controls use horizontal faders with a raised cap,
  a position stripe, and a fill measured from the minimum value.
- Stereo position uses a center mark and a fill measured from the center toward
  the selected side. Left, center, and right remain explicit in the readout.
- The A/B crossfader has a larger cap and endpoint labels. Its existing blend
  percentages and timed-transition behavior remain authoritative.
- Transport and toggle buttons have a shallow raised surface. Pressed, focused,
  disabled, selected, and warning states remain distinguishable.
- Output meters show the actual measured signal with a segmented scale and a
  separate held-peak marker. Their appearance must not invent audio activity.

Native range inputs retain their values, steps, keyboard controls, labels and
touch behavior. Styling a fader does not change gain scaling, add snapping, or
reset a setting. Equalizer inputs and waveform handles have their own rendering;
ordinary fader styling must not leak into them.

## Surfaces

Session controls, sound-library cards, active layers, transition decks, dialogs,
and expanded utility sections share restrained edge lighting and consistent
spacing. Form fields are recessed, and values use tabular digits where alignment
helps. Selected sounds and active toggles remain clear without relying on a
shadow or color alone. Empty, loading, error and saved states use the same visual
language as populated screens.

## Small screens and accessibility

Keep the current responsive ordering and horizontal faders. Controls must fit a
320 px viewport, including nested layer panels and long sound names. Touch
targets can be larger than the visible cap. Keyboard focus uses the existing
amber outline and remains visible around raised controls. High-contrast mode
uses system colors and explicit edges; reduced-motion preferences suppress
decorative transitions. Numeric settings and status text remain readable in
disabled and inactive states.

## Implementation

Shared panel, button, form and card styling lives in `apps/web/src/styles.css`.
`RangeInput` owns ordinary fader variants. Feature styles own meters, waveform
handles, transition details and other specialized controls. Use CSS and SVG
already supported by the app; no image assets or new dependencies are needed.
