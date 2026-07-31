/** A static waveform drawn from a stored 0..100 level envelope. The memo chips
 *  and the timeline voice card share it so a sent message reads as the same
 *  shape the speaker saw while recording. */
export function MiniWaveform(props: { levels: number[]; className?: string }) {
  const levels = props.levels.length > 0 ? props.levels : [0];
  return (
    <span className={`nx-miniwave ${props.className ?? ''}`} aria-hidden="true">
      {levels.map((level, index) => (
        <span
          key={index}
          className="nx-miniwave-bar"
          style={{ height: `${String(Math.max(8, Math.min(100, level)))}%` }}
        />
      ))}
    </span>
  );
}
