export type UUID = string;
export type PlayerId = string;
export type PersonaId = string;
export type SeatIndex = number;
export type Chips = number;
export type Stack = Chips;
export type Timestamp = number;
export type Milliseconds = number;
export type DeckSeed = string;

export type CardRank =
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'T'
  | 'J'
  | 'Q'
  | 'K'
  | 'A';

export type CardSuit = 'c' | 'd' | 'h' | 's';

export type Card = `${CardRank}${CardSuit}`;

export type HandStage =
  | 'deal'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'settled';

export type TableVariant = 'texas-holdem';

export type BettingStructure = 'no-limit' | 'pot-limit' | 'fixed-limit';

export type PersonaArchetype =
  | 'balanced'
  | 'tight-aggressive'
  | 'loose-aggressive'
  | 'tight-passive'
  | 'loose-passive'
  | 'exploitative';

export type ActionOrigin = 'ui' | 'ai' | 'automation';

export type ValidationWarningCode =
  | 'timeout_soft'
  | 'misclick_protection'
  | 'auto_muck';

export type PauseReason =
  | 'manual'
  | 'technical'
  | 'network'
  | 'moderation'
  | 'dealer-action';

export type SimulationTrigger = 'preflop' | 'postflop' | 'river' | 'showdown';

export type AnalyticsProvider = 'supabase' | 'segment' | 'noop';

export type ReplayTransport = 'redis' | 's3' | 'filesystem';

export type RuntimeMode = 'live' | 'replay' | 'simulation' | 'scenario';
