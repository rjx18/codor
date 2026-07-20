/**
 * Thinking effort as a slider.
 *
 * The reference hardcodes seven stops (Off…Max). This does not: the stops are
 * whatever the selected adapter declares, with "Default" always at position 0.
 * A harness that reports three levels gets a four-stop slider; one that reports
 * none gets no slider at all. Hardcoding the reference's seven would reintroduce
 * exactly the defect Phase 2 removed — a UI offering levels no harness accepts.
 *
 * The native range input is the control; the track, fill, ticks and riding
 * tooltip are drawn beside it. That keeps keyboard, touch and screen-reader
 * behaviour native rather than reimplemented.
 */
import type { ThinkingLevel } from '@codor/protocol';

export function ThinkingSlider(props: {
  /** Adapter-declared levels, in order. Empty means the harness has none. */
  levels: readonly ThinkingLevel[];
  /** '' is Default — position 0. */
  value: string;
  onChange: (next: string) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  // Position 0 is always Default; the declared levels follow it.
  const stops: readonly string[] = ['', ...props.levels];
  const max = stops.length - 1;
  const index = Math.max(0, stops.indexOf(props.value));
  const pct = max === 0 ? 0 : index / max;
  const label = (stop: string) => (stop === '' ? 'Default' : stop);

  return (
    <div className="nx-slider" data-testid={`${props.idPrefix}-thinking-slider`}>
      <div className="nx-slider-rail">
        <div className="nx-slider-fill" style={{ width: `${String(pct * 100)}%` }} />
        <div className="nx-slider-ticks" aria-hidden="true">
          {stops.map((stop, i) => (
            <span
              key={stop === '' ? 'default' : stop}
              className={i <= index ? 'nx-slider-tick is-on' : 'nx-slider-tick'}
              data-active={i === index}
            />
          ))}
        </div>
        {/* The knob and tooltip ride the same percentage as the fill. */}
        <span className="nx-slider-knob" style={{ left: `${String(pct * 100)}%` }} aria-hidden="true" />
        <span
          className="nx-slider-tip"
          style={{ left: `${String(pct * 100)}%` }}
          data-testid={`${props.idPrefix}-thinking-value`}
        >
          {label(stops[index] ?? '')}
        </span>
        <input
          type="range"
          className="nx-slider-input"
          min={0}
          max={max}
          step={1}
          value={index}
          disabled={props.disabled === true || max === 0}
          // The accessible name and value text carry the level, since the visual
          // tooltip is decorative.
          aria-label="Thinking effort"
          aria-valuetext={label(stops[index] ?? '')}
          data-testid={`${props.idPrefix}-thinking-range`}
          onChange={(event) => props.onChange(stops[Number(event.target.value)] ?? '')}
        />
      </div>
    </div>
  );
}
