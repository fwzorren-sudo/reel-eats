// The phone app's opening-hours and My Maps helpers. They're plain JS, so this test is too.
import { describe, expect, it } from "vitest";
import { clock, hoursNow, openState, placeClock } from "../public/hours.js";
import { toKml } from "../public/kml.js";

const daily = (openH, closeH, closeDayShift = 0) => ({
  periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    open: { day, hour: openH, minute: 0 },
    close: { day: (day + closeDayShift) % 7, hour: closeH, minute: 0 },
  })),
});
// Sunday 27 September 2026 at 18:30 UTC = 14:30 in New York (EDT) and 11:30 in Los Angeles.
const SUN_1830Z = new Date("2026-09-27T18:30:00Z");

describe("the place's own clock", () => {
  it("uses the place's time zone, including daylight saving", () => {
    expect(placeClock(SUN_1830Z, "America/New_York")).toEqual({ day: 0, minutes: 14 * 60 + 30 });
    expect(placeClock(new Date("2026-12-27T18:30:00Z"), "America/New_York")).toEqual({ day: 0, minutes: 13 * 60 + 30 });
    expect(placeClock(SUN_1830Z, "America/Los_Angeles")).toEqual({ day: 0, minutes: 11 * 60 + 30 });
  });
  it("falls back to the UTC offset Google gave", () => {
    expect(placeClock(SUN_1830Z, "", -240)).toEqual({ day: 0, minutes: 14 * 60 + 30 });
  });
});

describe("open now", () => {
  it("is open during the day and says when it closes", () => {
    expect(openState(daily(8, 17), SUN_1830Z, "America/New_York")).toMatchObject({ open: true, closesIn: 150 });
    expect(hoursNow({ hours: daily(8, 17), time_zone: "America/New_York" }, SUN_1830Z).text).toBe("Open · until 5 PM");
  });
  it("warns in the last hour", () => {
    const h = hoursNow({ hours: daily(8, 15), time_zone: "America/New_York" }, SUN_1830Z);
    expect(h).toMatchObject({ tone: "soon", text: "Closes soon · 3 PM" });
  });
  it("is closed before opening and says when it opens", () => {
    const h = hoursNow({ hours: daily(17, 23), time_zone: "America/New_York" }, SUN_1830Z);
    expect(h).toMatchObject({ open: false, text: "Closed · opens 5 PM" });
  });
  it("handles places open past midnight", () => {
    // Open 6pm to 2am; at 1:30am Monday it's still Sunday night's shift.
    const late = daily(18, 2, 1);
    expect(openState(late, new Date("2026-09-28T05:30:00Z"), "America/New_York")).toMatchObject({ open: true, closesIn: 30 });
    // Saturday night's shift runs into Sunday morning, across the end of the week.
    expect(openState(late, new Date("2026-09-27T05:30:00Z"), "America/New_York")).toMatchObject({ open: true });
  });
  it("names the day when it's closed until later in the week", () => {
    const weekdays = { periods: [1, 2, 3, 4, 5].map((day) => ({ open: { day, hour: 11, minute: 0 }, close: { day, hour: 21, minute: 0 } })) };
    expect(hoursNow({ hours: weekdays, time_zone: "America/New_York" }, new Date("2026-09-26T18:30:00Z")).text).toBe("Closed · opens Mon 11 AM");
    expect(hoursNow({ hours: weekdays, time_zone: "America/New_York" }, SUN_1830Z).text).toBe("Closed · opens tomorrow 11 AM");
  });
  it("knows 24-hour places and unknown hours", () => {
    expect(hoursNow({ hours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } }, SUN_1830Z).text).toBe("Open 24 hours");
    expect(hoursNow({ hours: null }, SUN_1830Z)).toBeNull();
  });
  it("formats times", () => {
    expect(clock({ hour: 0, minute: 0 })).toBe("12 AM");
    expect(clock({ hour: 21, minute: 30 })).toBe("9:30 PM");
  });
});

describe("Google My Maps export", () => {
  it("writes a pin per located place with escaped text and data columns", () => {
    const kml = toKml([
      { name: "Joe's <Pizza> & Co", located: 1, lat: 40.75, lng: -73.98, category: "Pizza", visit_status: "want", dishes: ["Slice"], tags: ["late night"], notes: "Cash ]]> only" },
      { name: "Nowhere", located: 0 },
    ]);
    expect(kml).toContain("<name>Joe&apos;s &lt;Pizza&gt; &amp; Co</name>");
    expect(kml).toContain("<coordinates>-73.98,40.75,0</coordinates>");
    expect(kml).toContain('<Data name="Status"><value>To try</value></Data>');
    expect(kml).toContain("Good for: late night");
    expect(kml).toContain("Cash ]]]]><![CDATA[> only");
    expect(kml).not.toContain("Nowhere");
  });
});
