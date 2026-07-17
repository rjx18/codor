import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ContextWindowMeter } from './ContextWindowMeter.js';

function render(used: number, max: number, totalCostUsd?: number): string {
  return renderToStaticMarkup(
    <ContextWindowMeter
      usage={{
        contextWindowUsedTokens: used,
        contextWindowMaxTokens: max,
        ...(totalCostUsd !== undefined && { totalCostUsd }),
      }}
    />,
  );
}

// harn:assume member-context-window-meter-derived-from-last-usage ref=context-window-meter-regression
describe('ContextWindowMeter', () => {
  it('stays hidden until both valid context fields are present', () => {
    expect(renderToStaticMarkup(<ContextWindowMeter usage={undefined} />)).toBe('');
    expect(renderToStaticMarkup(
      <ContextWindowMeter usage={{ contextWindowUsedTokens: 10_000 }} />,
    )).toBe('');
    expect(renderToStaticMarkup(
      <ContextWindowMeter usage={{ contextWindowUsedTokens: 0, contextWindowMaxTokens: 0 }} />,
    )).toBe('');
  });

  it('renders a track-only pending skeleton without context fields', () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={undefined} pending />);
    expect(markup).toContain('is-pending');
    expect(markup).toContain('nx-context-meter-track');
    expect(markup).not.toContain('nx-context-meter-progress');
  });

  it('uses the normal state below 70 percent and reports tokens and session cost', () => {
    const markup = render(100_000, 200_000, 0.0042);
    expect(markup).toContain('is-normal');
    expect(markup).toContain('data-percentage="50"');
    expect(markup).toContain('100K / 200K tokens');
    expect(markup).toContain('Session cost: $0.0042');
  });

  it('uses amber from 70 through 90 percent inclusive', () => {
    expect(render(70_000, 100_000)).toContain('is-amber');
    expect(render(90_000, 100_000)).toContain('is-amber');
  });

  it('uses red above 90 percent and clamps the drawn arc', () => {
    const markup = render(110_000, 100_000);
    expect(markup).toContain('is-red');
    expect(markup).toContain('data-percentage="110"');
    expect(markup).toContain('stroke-dashoffset="0"');
  });
});
// harn:end member-context-window-meter-derived-from-last-usage
