import { describe, expect, it } from "vitest";
import { istMonth, istMonthStart, istToday } from "../src/utils/ist";

/**
 * Phase 9.1 date tests: freeze the clock at various UTC instants that
 * straddle the IST day/month boundary and assert "today"/"this month" land
 * on the correct IST calendar day, not the UTC one. IST is UTC+5:30, so
 * anything from 00:00 to 05:29:59 UTC is already the next IST day.
 */
describe("ist utilities", () => {
  it("istToday returns the UTC day when it's daytime UTC (well within the IST day)", () => {
    // 2026-01-15 12:00 UTC = 2026-01-15 17:30 IST
    expect(istToday(new Date("2026-01-15T12:00:00.000Z"))).toBe("2026-01-15");
  });

  it("istToday rolls over to the next day for the UTC-midnight-to-05:30 window", () => {
    // 2026-01-15 23:59 UTC = 2026-01-16 05:29 IST -- still the 16th in IST
    expect(istToday(new Date("2026-01-15T23:59:00.000Z"))).toBe("2026-01-16");
    // 2026-01-16 00:00 UTC = 2026-01-16 05:30 IST
    expect(istToday(new Date("2026-01-16T00:00:00.000Z"))).toBe("2026-01-16");
    // 2026-01-16 05:00 UTC = 2026-01-16 10:30 IST
    expect(istToday(new Date("2026-01-16T05:00:00.000Z"))).toBe("2026-01-16");
  });

  it("istToday does not roll over before the IST-midnight boundary", () => {
    // 2026-01-15 18:00 UTC = 2026-01-15 23:30 IST -- still the 15th
    expect(istToday(new Date("2026-01-15T18:00:00.000Z"))).toBe("2026-01-15");
    // 2026-01-15 18:29 UTC = 2026-01-15 23:59 IST -- last minute of the 15th
    expect(istToday(new Date("2026-01-15T18:29:00.000Z"))).toBe("2026-01-15");
    // 2026-01-15 18:30 UTC = 2026-01-16 00:00 IST -- first instant of the 16th
    expect(istToday(new Date("2026-01-15T18:30:00.000Z"))).toBe("2026-01-16");
  });

  it("istMonth rolls over at the IST month boundary, not the UTC one", () => {
    // 2026-01-31 19:00 UTC = 2026-02-01 00:30 IST -- already February in IST
    expect(istMonth(new Date("2026-01-31T19:00:00.000Z"))).toBe("2026-02");
    // 2026-01-31 18:00 UTC = 2026-01-31 23:30 IST -- still January in IST
    expect(istMonth(new Date("2026-01-31T18:00:00.000Z"))).toBe("2026-01");
  });

  it("istMonthStart returns the first of the current IST month", () => {
    expect(istMonthStart(new Date("2026-02-15T12:00:00.000Z"))).toBe("2026-02-01");
    // 2026-02-28 19:00 UTC = 2026-03-01 00:30 IST
    expect(istMonthStart(new Date("2026-02-28T19:00:00.000Z"))).toBe("2026-03-01");
  });

  it("handles the December/January year boundary", () => {
    // 2025-12-31 19:00 UTC = 2026-01-01 00:30 IST
    expect(istToday(new Date("2025-12-31T19:00:00.000Z"))).toBe("2026-01-01");
    expect(istMonth(new Date("2025-12-31T19:00:00.000Z"))).toBe("2026-01");
  });
});
