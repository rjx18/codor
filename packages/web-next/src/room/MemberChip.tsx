import type { Member } from '@codor/protocol';

import { memberAccent, memberHue, memberMarkId, memberTone } from '../primitives/identity.js';
import { Chip } from '../primitives/primitives.js';
import { harnessLabel, harnessMark } from './harness-marks.js';

export function MemberChip(props: {
  member: Member;
  size?: number;
  presence?: 'live' | 'idle' | 'error';
  surface?: 'surface' | 'raised' | 'muted';
}) {
  const markId = memberMarkId(props.member);
  return (
    <Chip
      name={props.member.display_name || props.member.handle}
      accent={memberAccent(props.member)}
      hue={memberHue(props.member)}
      tone={memberTone(props.member)}
      mark={markId === undefined ? undefined : harnessMark(markId, props.size === undefined ? 19 : Math.round(props.size * 0.56))}
      size={props.size}
      presence={props.presence}
      surface={props.surface}
      title={markId === undefined
        ? props.member.display_name || props.member.handle
        : `${props.member.display_name || props.member.handle} · ${harnessLabel(markId)}`}
    />
  );
}
