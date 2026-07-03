import { describe, expectTypeOf, test } from 'vitest';

import type { PlayerAction, PlayerOption, TurnEvent } from '../events';
import type { RuntimeContext, Session } from '../session';
import type { TableSnapshot } from '../snapshot';

describe('poker engine schema types', () => {
  test('runtime context exposes all documented modes', () => {
    expectTypeOf<RuntimeContext['mode']>().toEqualTypeOf<
      'live' | 'replay' | 'simulation' | 'scenario'
    >();
  });

  test('player actions remain a discriminated union', () => {
    expectTypeOf<PlayerAction['type']>().toEqualTypeOf<
      | 'fold'
      | 'check'
      | 'call'
      | 'bet'
      | 'raise'
      | 'all-in'
      | 'post-blind'
      | 'post-ante'
      | 'timeout'
      | 'resume'
    >();
  });

  test('turn events carry player options for auditing', () => {
    expectTypeOf<
      TurnEvent['legalOptions'][number]
    >().toMatchTypeOf<PlayerOption>();
  });

  test('snapshots replay turn events recorded in rounds', () => {
    expectTypeOf<
      TableSnapshot['hand']['bettingRounds'][number]['turns'][number]
    >().toEqualTypeOf<TurnEvent>();
  });

  test('session instances always expose runtime context', () => {
    expectTypeOf<Session>().toMatchTypeOf<{ runtimeContext: RuntimeContext }>();
  });
});
