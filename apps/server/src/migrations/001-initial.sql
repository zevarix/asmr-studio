CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  mime TEXT NOT NULL,
  extension TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  display_name TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
  channels INTEGER NOT NULL CHECK (channels > 0),
  format TEXT NOT NULL,
  provenance_kind TEXT NOT NULL,
  source TEXT,
  private_use TEXT NOT NULL,
  redistribution TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document TEXT NOT NULL
);
PRAGMA user_version = 1;
