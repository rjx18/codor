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
  // Keep the visual thumb and tooltip inside the rail at both endpoints. The
  // native range uses the same half-thumb inset rather than putting its center
  // on the element's outer edge.
  const position = `calc(8px + ${String(pct * 100)}% - ${String(pct * 16)}px)`;
  const fillWidth = `calc(${String(pct * 100)}% - ${String(pct * 16)}px)`;
  const tipTransform = pct === 0 ? 'translateX(0)' : pct === 1 ? 'translateX(-100%)' : 'translateX(-50%)';

  return (
    <div className="nx-slider" data-testid={`${props.idPrefix}-thinking-slider`}>
      <div className="nx-slider-rail">
        <div className="nx-slider-fill" style={{ width: fillWidth }} />
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
        <span className="nx-slider-knob" style={{ left: position }} aria-hidden="true" />
        <span
          className="nx-slider-tip"
          style={{ left: position, transform: tipTransform }}
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
      <div className="nx-slider-ends" aria-hidden="true" data-testid={`${props.idPrefix}-thinking-ends`}>
        <span>{label(stops[0] ?? '')}</span>
        <span>{label(stops[max] ?? '')}</span>
      </div>
    </div>
  );
}
