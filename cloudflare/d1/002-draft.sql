-- DropLeaf 草稿支持：
-- 1) draft 表：单人剪贴板的唯一当前草稿。
--    「无行」表示不存在草稿；「content='' 的行」表示用户主动清空的空草稿（两个不同状态）。
--    revision 单调递增（PUT /draft 乐观锁）；id 在每次保存归档后更换（防迟到写覆盖新草稿）。
-- 2) messages.draft_id：保存归档时留下草稿 id 痕迹，实现「同一份草稿只归档一次」的幂等。

CREATE TABLE IF NOT EXISTS draft (
  k INTEGER PRIMARY KEY CHECK (k = 0),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN draft_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_draft_id ON messages(draft_id);

-- 3) app_state：KV 状态（当前只有 session_epoch —— 会话纪元）。
--    退出登录 = 纪元 +1：所有已签发会话令牌（claims.ver < 纪元）立即作废。
--    Worker 内也做幂等懒建，此处建表只是让「初始化即完整」。
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
