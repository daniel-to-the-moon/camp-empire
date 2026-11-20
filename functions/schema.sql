-- T1 匿名统计表（D1）。只存随机匿名 ID、事件名、上海日序号、服务器时间、版本号；不存 IP、设备、页面地址。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  aid TEXT NOT NULL,
  ev TEXT NOT NULL,
  day INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_day ON events (day);
CREATE INDEX IF NOT EXISTS events_aid ON events (aid, day);
