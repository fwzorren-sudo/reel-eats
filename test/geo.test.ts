import { describe, expect, it } from "vitest";
import { distanceMeters, namesMatch, websiteHost } from "../src/geo";

describe("namesMatch", () => {
  const yes: [string, string][] = [
    ["Joe's Pizza Broadway", "Joe's Pizza"],
    ["Joe’s Pizza", "Joes Pizza"],
    ["Tacos El Gordo de Tijuana", "Tacos El Gordo"],
    ["Katz's Deli", "Katz's Delicatessen"],
    ["Shake Shack Madison Square Park", "Shake Shack"],
    ["Din Tai Fung Dumpling House", "Din Tai Fung"],
    ["Birrialandia", "Birria-Landia"],
    ["Café Mogador", "Cafe Mogador"],
    ["The Smith", "Smith"],
    ["L'Industrie Pizzeria", "L'industrie"],
    ["In-N-Out Burger", "In N Out"],
    ["Tacos Del Norte", "tacosdelnorte"],
    ["Lucali", "eat.lucali"],
    ["Joe's Pizza", "joespizzanyc"],
  ];
  const no: [string, string][] = [
    ["Joe's Shanghai", "Joe's Pizza"],
    ["Falafel", "Mamoun's Falafel"],
    ["Pizza Hut", "Joe's Pizza"],
    ["Starbucks", "Blue Bottle Coffee"],
    ["Joe's Pizza", ""],
    ["Pizza", "joespizzanyc"],
  ];
  it.each(yes)("%s ≈ %s", (a, b) => expect(namesMatch(a, b)).toBe(true));
  it.each(no)("%s ≠ %s", (a, b) => expect(namesMatch(a, b)).toBe(false));
});

describe("distanceMeters", () => {
  it("measures Manhattan to Brooklyn roughly right", () => {
    const d = distanceMeters(40.7484, -73.9857, 40.6782, -73.9442);
    expect(d).toBeGreaterThan(8000);
    expect(d).toBeLessThan(9000);
  });
});

describe("websiteHost", () => {
  it("ignores hosts shared by unrelated businesses", () => {
    expect(websiteHost("https://www.instagram.com/joespizza")).toBe("");
    expect(websiteHost("https://joes.toasttab.com/")).toBe("");
    expect(websiteHost("https://www.shakeshack.com/location/x")).toBe("shakeshack.com");
    expect(websiteHost("not a url")).toBe("");
  });
});
