import { compactCount, usd } from '../primitives/identity.js';

export interface CostProvenance {
  cost_usd: number;
  estimated_cost_usd?: number;
  uncosted_tokens?: number;
}

// harn:assume estimated-cost-is-advisory-not-spend-brake-input ref=member-advisory-cost-surface
export function costProvenanceLabel(value: CostProvenance): string {
  const estimate = value.estimated_cost_usd ?? 0;
  const unknown = value.uncosted_tokens ?? 0;
  const mixed = (value.cost_usd > 0 ? 1 : 0) + (estimate > 0 ? 1 : 0) + (unknown > 0 ? 1 : 0) > 1;
  const parts: string[] = [];
  if (value.cost_usd > 0 || (estimate === 0 && unknown === 0)) {
    parts.push(`${usd(value.cost_usd)}${mixed ? ' exact' : ''}`);
  }
  if (estimate > 0) parts.push(`~${usd(estimate)} est.`);
  if (unknown > 0) parts.push(`${compactCount(unknown)} unpriced tokens`);
  return parts.join(' + ');
}
// harn:end estimated-cost-is-advisory-not-spend-brake-input
