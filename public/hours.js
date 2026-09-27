/* Opening hours: is a place open right now, in its own time zone? Days are 0 = Sunday. */

const WEEK = 7 * 1440;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The day and minutes past midnight at the place, for a given moment. */
export function placeClock(now, timeZone, utcOffset) {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(now);
      const get = (type) => parts.find((p) => p.type === type)?.value;
      const day = DAYS.indexOf(get("weekday"));
      if (day >= 0) return { day, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
    } catch {
      /* unknown time zone: fall through */
    }
  }
  if (typeof utcOffset === "number") {
    const d = new Date(now.getTime() + utcOffset * 60000);
    return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  return { day: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
}

const at = (p) => p.day * 1440 + p.hour * 60 + (p.minute || 0);

/**
 * { open, closesIn, closesAt } or { open: false, opensIn, opensAt }, in minutes and
 * Google's {day, hour, minute}. Null when the hours are unknown.
 */
export function openState(hours, now = new Date(), timeZone = "", utcOffset = null) {
  const periods = hours?.periods;
  if (!Array.isArray(periods) || !periods.length) return null;
  // Google marks "open 24 hours" as a single period with no close.
  if (periods.some((p) => p.open && !p.close)) return { open: true, allDay: true };

  const { day, minutes } = placeClock(now, timeZone, utcOffset);
  const t = day * 1440 + minutes;
  let next = null;
  for (const p of periods) {
    if (!p.open || !p.close) continue;
    const o = at(p.open);
    let c = at(p.close);
    if (c <= o) c += WEEK; // closes after midnight, or on a later day
    for (const shift of [0, -WEEK]) {
      if (t >= o + shift && t < c + shift) return { open: true, closesIn: c + shift - t, closesAt: p.close };
    }
    const wait = (o - t + WEEK) % WEEK;
    if (!next || wait < next.wait) next = { wait, at: p.open };
  }
  return next ? { open: false, opensIn: next.wait, opensAt: next.at } : { open: false };
}

/** "10 PM", "9:30 AM" */
export function clock({ hour, minute = 0 }) {
  const h = hour % 12 || 12;
  return `${h}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour % 24 < 12 ? "AM" : "PM"}`;
}

/** Short text for a list row or detail card, and a tone for styling. */
export function describeOpen(state, today) {
  if (!state) return null;
  if (state.allDay) return { text: "Open 24 hours", tone: "open" };
  if (state.open) {
    if (state.closesIn <= 60) return { text: `Closes soon · ${clock(state.closesAt)}`, tone: "soon" };
    return { text: `Open · until ${clock(state.closesAt)}`, tone: "open" };
  }
  if (state.opensAt == null) return { text: "Closed", tone: "closed" };
  const sameDay = state.opensAt.day === today && state.opensIn < 1440;
  const when = sameDay ? clock(state.opensAt) : state.opensIn < 2880 && state.opensAt.day === (today + 1) % 7 ? `tomorrow ${clock(state.opensAt)}` : `${DAYS[state.opensAt.day]} ${clock(state.opensAt)}`;
  return { text: `Closed · opens ${when}`, tone: "closed" };
}

/** Everything the app needs about a place's hours right now. */
export function hoursNow(place, now = new Date()) {
  const state = openState(place.hours, now, place.time_zone, place.utc_offset);
  if (!state) return null;
  const { day } = placeClock(now, place.time_zone, place.utc_offset);
  return { ...state, ...describeOpen(state, day), today: day };
}
