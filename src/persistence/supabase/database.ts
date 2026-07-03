/**
 * Minimal, self-contained schema types for the Supabase persistence adapter.
 *
 * This describes only the two tables the adapter actually reads and writes —
 * `engine_hands` (one row per hand, holding the initial snapshot envelope) and
 * `engine_hand_events` (the append-only event log). It follows the shape that
 * `@supabase/supabase-js` generates with `supabase gen types typescript`, so
 * `SupabaseClient<Database>` type-checks against a real generated schema too.
 *
 * Run the adapter against your own database by creating these tables (or by
 * widening the client generic if your schema differs).
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      engine_hands: {
        Row: {
          id: string;
          initial_snapshot: Json;
        };
        Insert: {
          id: string;
          initial_snapshot: Json;
        };
        Update: {
          id?: string;
          initial_snapshot?: Json;
        };
        Relationships: [];
      };
      engine_hand_events: {
        Row: {
          id: string;
          engine_hand_id: string;
          event_index: number;
          occurred_at: string;
          payload: Json;
        };
        Insert: {
          id?: string;
          engine_hand_id: string;
          event_index: number;
          occurred_at?: string;
          payload: Json;
        };
        Update: {
          id?: string;
          engine_hand_id?: string;
          event_index?: number;
          occurred_at?: string;
          payload?: Json;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
