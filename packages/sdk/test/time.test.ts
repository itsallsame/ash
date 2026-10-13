import assert from "node:assert/strict";
import test from "node:test";
import { localStamp } from "../src/time";

// 2026-10-10T16:13:00Z is 00:13 on the 11th in Shanghai: the hour an agent must not read off the UTC instant.
const AT = Date.UTC(2026, 9, 10, 16, 13, 0);

test("the stamp is the zone's wall clock with the zone and its offset", () => {
  assert.equal(localStamp(AT, "Asia/Shanghai"), "2026-10-11 Sun 00:13:00 Asia/Shanghai (UTC+08:00)");
  assert.equal(localStamp(AT, "UTC"), "2026-10-10 Sat 16:13:00 UTC (UTC+00:00)");
  assert.equal(localStamp(AT, "America/New_York"), "2026-10-10 Sat 12:13:00 America/New_York (UTC-04:00)");
  assert.equal(localStamp(AT, "Asia/Kolkata"), "2026-10-10 Sat 21:43:00 Asia/Kolkata (UTC+05:30)");
});

test("an unknown zone reads as UTC, and the default is the zone this process runs in", () => {
  assert.equal(localStamp(AT, "Not/AZone"), "2026-10-10 Sat 16:13:00 UTC (UTC+00:00)");
  assert.equal(localStamp(AT), localStamp(AT, Intl.DateTimeFormat().resolvedOptions().timeZone));
});

test("midnight is hour 00, not 24", () => {
  assert.equal(localStamp(Date.UTC(2026, 9, 10, 16, 0, 0), "Asia/Shanghai"), "2026-10-11 Sun 00:00:00 Asia/Shanghai (UTC+08:00)");
});

test("the weekday is the local one: across midnight and across zones", () => {
  // UTC Saturday 16:00 is already Sunday in Shanghai, still Saturday in New York.
  const at = Date.UTC(2026, 9, 10, 16, 0, 0);
  assert.match(localStamp(at, "UTC"), /^2026-10-10 Sat /);
  assert.match(localStamp(at, "Asia/Shanghai"), /^2026-10-11 Sun /);
  assert.match(localStamp(at, "America/New_York"), /^2026-10-10 Sat /);
  // Sunday 23:59 / Monday 00:00 in Shanghai, either side of the local midnight.
  assert.match(localStamp(Date.UTC(2026, 9, 11, 15, 59, 59), "Asia/Shanghai"), /^2026-10-11 Sun 23:59:59 /);
  assert.match(localStamp(Date.UTC(2026, 9, 11, 16, 0, 0), "Asia/Shanghai"), /^2026-10-12 Mon 00:00:00 /);
  // Westward: UTC Monday 02:00 is Sunday evening in Los Angeles.
  assert.match(localStamp(Date.UTC(2026, 9, 12, 2, 0, 0), "America/Los_Angeles"), /^2026-10-11 Sun 19:00:00 /);
  // Every weekday name, one week of noons in UTC.
  const names = [12, 13, 14, 15, 16, 17, 18].map((d) => localStamp(Date.UTC(2026, 9, d, 12), "UTC").split(" ")[1]);
  assert.deepEqual(names, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  // The fallback to UTC for an unknown zone carries the UTC weekday.
  assert.match(localStamp(at, "Not/AZone"), /^2026-10-10 Sat /);
});
