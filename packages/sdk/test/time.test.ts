import assert from "node:assert/strict";
import test from "node:test";
import { localStamp } from "../src/time";

// 2026-10-10T16:13:00Z is 00:13 on the 11th in Shanghai: the hour an agent must not read off the UTC instant.
const AT = Date.UTC(2026, 9, 10, 16, 13, 0);

test("the stamp is the zone's wall clock with the zone and its offset", () => {
  assert.equal(localStamp(AT, "Asia/Shanghai"), "2026-10-11 00:13:00 Asia/Shanghai (UTC+08:00)");
  assert.equal(localStamp(AT, "UTC"), "2026-10-10 16:13:00 UTC (UTC+00:00)");
  assert.equal(localStamp(AT, "America/New_York"), "2026-10-10 12:13:00 America/New_York (UTC-04:00)");
  assert.equal(localStamp(AT, "Asia/Kolkata"), "2026-10-10 21:43:00 Asia/Kolkata (UTC+05:30)");
});

test("an unknown zone reads as UTC, and the default is the zone this process runs in", () => {
  assert.equal(localStamp(AT, "Not/AZone"), "2026-10-10 16:13:00 UTC (UTC+00:00)");
  assert.equal(localStamp(AT), localStamp(AT, Intl.DateTimeFormat().resolvedOptions().timeZone));
});

test("midnight is hour 00, not 24", () => {
  assert.equal(localStamp(Date.UTC(2026, 9, 10, 16, 0, 0), "Asia/Shanghai"), "2026-10-11 00:00:00 Asia/Shanghai (UTC+08:00)");
});
