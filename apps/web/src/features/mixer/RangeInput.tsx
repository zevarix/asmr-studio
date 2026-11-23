import type {ComponentPropsWithoutRef, CSSProperties} from 'react';
import './RangeInput.css';

type RangeInputProps = Omit<ComponentPropsWithoutRef<'input'>, 'type'> & {
  variant?:'amount'|'pan'|'crossfader';
};

/** Native keyboard/touch behavior with a shared visual fill for all mixer sliders. */
export function RangeInput({value, min = 0, max = 100, style, className, variant = 'amount', ...props}:RangeInputProps) {
  const span = Number(max) - Number(min);
  const amount = span > 0 ? (Number(value) - Number(min)) / span * 100 : 0;
  const fill = Number.isFinite(amount) ? Math.min(100, Math.max(0, amount)) : 0;
  const origin = variant === 'pan' ? 50 : 0;
  return <input {...props} type="range" min={min} max={max} value={value}
    className={['studio-range',`studio-range--${variant}`,className].filter(Boolean).join(' ')}
    style={{...style, '--range-fill': `${fill}%`, '--range-start': `${Math.min(origin,fill)}%`,
      '--range-end': `${Math.max(origin,fill)}%`} as CSSProperties}/>;
}
