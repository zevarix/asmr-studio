import type {ComponentPropsWithoutRef, CSSProperties} from 'react';

/** Native keyboard/touch behavior with a shared visual fill for all mixer sliders. */
export function RangeInput({value, min = 0, max = 100, style, ...props}: Omit<ComponentPropsWithoutRef<'input'>, 'type'>) {
  const span = Number(max) - Number(min);
  const amount = span > 0 ? (Number(value) - Number(min)) / span * 100 : 0;
  const fill = Number.isFinite(amount) ? Math.min(100, Math.max(0, amount)) : 0;
  return <input {...props} type="range" min={min} max={max} value={value}
    style={{...style, '--range-fill': `${fill}%`} as CSSProperties}/>;
}
