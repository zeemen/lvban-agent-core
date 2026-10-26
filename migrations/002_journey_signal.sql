-- 规格 01 §1.1：L1 旅程层包含 journey_signal
-- D2 蒸馏按 (dimension, value) 在本次旅程内计数，阈值见 config.distillation.d2SignalCountMin
-- 注意 source 不含 system_inferred —— 推断信号只进 L0（Redis），永不落库

CREATE TABLE journey_signal (
  id             uuid PRIMARY KEY,
  journey_id     uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dimension      text NOT NULL,
  value          text NOT NULL,
  weight         numeric(3,2) NOT NULL DEFAULT 1.00,
  source         text NOT NULL CHECK (source IN ('explicit','user_confirmed')),
  evidence_interaction_id uuid REFERENCES interaction(id) ON DELETE SET NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX journey_signal_journey_idx ON journey_signal (journey_id, dimension, value);
CREATE INDEX journey_signal_user_idx ON journey_signal (user_id, occurred_at DESC);
