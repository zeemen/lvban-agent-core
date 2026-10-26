-- 旅伴 Agent · 初始 Schema
-- 实现依据：specs/01-Personal-Memory-System-技术规格-V1.0.md §2.3
--           specs/02-Location-Context-Engine-技术规格-V1.0.md §1
-- 约定：时间统一 timestamptz(UTC)；ID 用 UUIDv7（应用层生成）；坐标系 gcj02

CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────── L3 身份 / 账户 ───────────────────────────────

CREATE TABLE app_user (
  id               uuid PRIMARY KEY,
  wx_openid        text UNIQUE NOT NULL,
  wx_unionid       text,
  nickname         text,
  age_band         text NOT NULL DEFAULT 'unknown'
                     CHECK (age_band IN ('under_12','12_15','16_18','19_24','25_plus','unknown')),
  birth_year       int,
  default_mode     text NOT NULL DEFAULT 'companion'
                     CHECK (default_mode IN ('companion','family_study','light_guide')),
  explain_pref     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_minor         boolean GENERATED ALWAYS AS
                     (age_band IN ('under_12','12_15','16_18')) STORED,
  guardian_user_id uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE family (
  id         uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE family_member (
  family_id    uuid NOT NULL REFERENCES family(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('parent','child','sibling','other')),
  guardianship boolean NOT NULL DEFAULT false,
  unbound_at   timestamptz,
  PRIMARY KEY (family_id, user_id)
);

CREATE TABLE identity_trait (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  trait               text NOT NULL,
  status              text NOT NULL DEFAULT 'candidate'
                        CHECK (status IN ('candidate','active','user_removed')),
  supporting_journeys uuid[] NOT NULL DEFAULT '{}',
  party_invariant     boolean NOT NULL DEFAULT false,
  promoted_at         timestamptz,
  explanation         text NOT NULL,
  UNIQUE (user_id, trait)
);

-- ─────────────────────────────── L1 旅程 ───────────────────────────────

CREATE TABLE trip (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  city       text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journey (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  trip_id            uuid REFERENCES trip(id),
  mode               text NOT NULL CHECK (mode IN ('companion','family_study','light_guide')),
  party              text NOT NULL CHECK (party IN ('solo','parent_child','friends','group')),
  co_travelers       uuid[] NOT NULL DEFAULT '{}',
  scene_id           text NOT NULL,
  -- Journey 状态机（规格 02 §1）
  state              text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (state IN ('CONSENT','DECLINED','ACTIVE','IDLE',
                                        'AUTO_ENDED','ENDED','DISTILLING','CLOSED','PURGED')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  -- Usage Mode Collection（规格 01 §2.3 / 02 §1.1）
  track_consent      text NOT NULL DEFAULT 'visited_points_only'
                       CHECK (track_consent IN ('none','visited_points_only','full_track')),
  consent_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_track_purge_at timestamptz,
  distilled_at       timestamptz,
  deleted_at         timestamptz
);

CREATE INDEX journey_user_started_idx ON journey (user_id, started_at DESC);
CREATE INDEX journey_active_idx ON journey (user_id) WHERE state IN ('ACTIVE','IDLE');

CREATE TABLE location_event (
  id          uuid PRIMARY KEY,
  journey_id  uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('arrive','dwell','leave','skip','confirm_zone')),
  poi_id      text,
  exhibit_id  text,
  source      text NOT NULL CHECK (source IN ('geofence','user_confirmed','vision_anchor','inferred')),
  confidence  numeric(3,2),
  dwell_sec   int,
  occurred_at timestamptz NOT NULL,
  -- 规格 02 §4.4：室内不伪造精确位置，vision/确认来源不得带坐标
  CONSTRAINT vision_anchor_needs_confidence
    CHECK (source <> 'vision_anchor' OR confidence IS NOT NULL)
);

CREATE INDEX location_event_journey_idx ON location_event (journey_id, occurred_at);

CREATE TABLE interaction (
  id            uuid PRIMARY KEY,
  journey_id    uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  turn_index    int NOT NULL,
  role          text NOT NULL CHECK (role IN ('user','agent')),
  channel       text NOT NULL CHECK (channel IN ('text','voice','photo','tap','silent_card')),
  content       text,
  anchor_id     text,
  topic_tags    text[] NOT NULL DEFAULT '{}',
  evidence_refs jsonb,
  was_ignored   boolean NOT NULL DEFAULT false,
  occurred_at   timestamptz NOT NULL,
  UNIQUE (journey_id, turn_index)
);

CREATE INDEX interaction_journey_idx ON interaction (journey_id, turn_index);
CREATE INDEX interaction_topics_idx ON interaction USING gin (topic_tags);

-- 原始轨迹：仅 full_track 授权时写入，journey 结束后 7 天内物理删除（规格 01 D4）
CREATE TABLE raw_track_point (
  journey_id  uuid NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy_m  real,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX raw_track_journey_idx ON raw_track_point (journey_id, recorded_at);

-- 语义足迹：L1 的长期压缩产物（规格 01 §2.3）
CREATE TABLE semantic_footprint (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  journey_id     uuid NOT NULL REFERENCES journey(id) ON DELETE CASCADE,
  city           text NOT NULL,
  place          text NOT NULL,
  parent_place   text,
  dwell_sec      int NOT NULL DEFAULT 0,
  question_count int NOT NULL DEFAULT 0,
  interest_signal text CHECK (interest_signal IN ('low','medium','high')),
  topics         text[] NOT NULL DEFAULT '{}',
  moment         text,
  occurred_on    date NOT NULL
);

CREATE INDEX footprint_user_idx ON semantic_footprint (user_id, occurred_on DESC);
CREATE INDEX footprint_topics_idx ON semantic_footprint USING gin (topics);

-- ─────────────────────────────── L2 偏好 ───────────────────────────────

CREATE TABLE preference (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  dimension     text NOT NULL,
  value         text NOT NULL,
  strength      numeric(3,2) NOT NULL DEFAULT 0.50,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('mentioned_once','active','decayed','user_removed')),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  journey_count int NOT NULL DEFAULT 1,
  -- 规格 01 §2.3：故意不含 system_inferred —— 推断永不进 L2
  source        text NOT NULL CHECK (source IN ('explicit','user_confirmed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dimension, value)
);

CREATE INDEX preference_user_active_idx ON preference (user_id)
  WHERE status IN ('active','mentioned_once');

-- ─────────────────────────────── 审计 ───────────────────────────────

CREATE TABLE memory_audit (
  id         uuid PRIMARY KEY,
  user_id    uuid,
  action     text NOT NULL CHECK (action IN
               ('write','reject','promote','decay','delete','export','purge')),
  layer      text,
  target_id  uuid,
  reason     text,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_audit_user_idx ON memory_audit (user_id, created_at DESC);

-- 注：schema_migration 由 src/db/migrate.ts 自行创建，不在业务迁移内声明。
