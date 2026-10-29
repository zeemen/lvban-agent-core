-- PRD U02：建档三问可跳过，所以「没答」和「答了个恰好等于默认值的答案」必须分得开。
-- age_band 默认 'unknown' 还看得出没答，default_mode 默认 'companion' 就看不出了——
-- 用户选了「像朋友一起逛」和从没打开过建档页，库里长得一模一样。
-- 行前提示要不要出现，取决于这个区分，所以记一个「答过任何一问」的时间。

ALTER TABLE app_user ADD COLUMN profile_updated_at timestamptz;

-- 已有用户答过的痕迹只剩两处：age_band 不是 unknown，或 explain_pref 里写过 voice。
-- 认得出的回填 created_at；认不出的留空，下次开旅程会被提示一次，可接受。
UPDATE app_user
   SET profile_updated_at = created_at
 WHERE age_band <> 'unknown' OR explain_pref ? 'voice';
