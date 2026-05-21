import { describe, expect, it } from 'vitest';
import { beginLoadReplayState, evaluateLoadReplay, markLoadReplayDone } from './loadReplay';

describe('session/load replay lifecycle', () => {
  it('stays restoring until the explicit replay_done marker arrives', () => {
    const state = beginLoadReplayState(1000);

    expect(evaluateLoadReplay(state)).toBe('restoring');
  });

  it('settles live when replay_done is observed', () => {
    const state = markLoadReplayDone(beginLoadReplayState(1000));

    expect(evaluateLoadReplay(state)).toBe('live');
  });
});
