/**
 * The time an agent reads in a message: the owner's wall clock and the zone it is in, never UTC. An agent that is handed
 * an ISO instant repeats its hour as the local one ("remind you at 16:13" for 00:13 in Shanghai), so every message
 * carries the local time, spelled out with the zone and its offset. `zone` is an IANA name; an unknown one reads as UTC.
 */
export function localStamp(at: number, zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const formatIn = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let name = zone;
  let format: Intl.DateTimeFormat;
  try { format = formatIn(name); } catch { name = "UTC"; format = formatIn(name); }
  const p = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0"), mm = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${name} (UTC${sign}${hh}:${mm})`;
}
