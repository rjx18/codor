// harn:assume web-presentation-model-defaults-to-v4-until-adopted ref=v5-presentation-model
// A pure derivation from (surface, viewport width, adoption) to one presentation mode.
// No hook, no media-query listener, no subscription: purity is the point, so this phase
// has no lifecycle to test or leak. The room phase binds it to a live viewport later.

/** Every room surface the model knows about. */
export type Surface =
  | 'message'
  | 'run'
  | 'tool'
  | 'ask'
  | 'hold'
  | 'composer'
  | 'member'
  | 'channel-row';

/**
 * framed-v4        the legacy presentation; what an unadopted surface still renders.
 * framed-desktop   the v5 framed card presentation.
 * unframed-mobile  the v5 unframed prose presentation (mobile, ordinary content only).
 */
export type PresentationMode = 'framed-v4' | 'framed-desktop' | 'unframed-mobile';

/**
 * 720 is the content breakpoint: below it, ordinary message and tool presentation unframes.
 * The shell's collapse to a single column is a separate 1024 concern owned by the shell,
 * not by this model.
 */
export const CONTENT_BREAKPOINT = 720;

/**
 * The surfaces the master unframes on a phone: ordinary messages and tool presentation.
 * Everything else - approvals, held deliveries, the pill composer, member cards, channel
 * rows - stays framed at every width.
 */
const UNFRAMES_ON_MOBILE: ReadonlySet<Surface> = new Set<Surface>(['message', 'run', 'tool']);

/**
 * Resolve how a surface should present. An unadopted surface always resolves to framed-v4,
 * so introducing this derivation changes no rendered pixel. Once adopted, only the
 * mobile-unframing surfaces go unframed below the content breakpoint; the rest stay framed.
 */
export function resolvePresentation(
  surface: Surface,
  width: number,
  adopted: boolean,
): PresentationMode {
  if (!adopted) return 'framed-v4';
  if (width < CONTENT_BREAKPOINT && UNFRAMES_ON_MOBILE.has(surface)) return 'unframed-mobile';
  return 'framed-desktop';
}
// harn:end web-presentation-model-defaults-to-v4-until-adopted
