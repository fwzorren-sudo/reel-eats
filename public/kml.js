/* Export for Google My Maps: in My Maps, create a map, then Import and pick the file. */

const xml = (s) =>
  String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

/** KML with one pin per located place. The data columns let My Maps style pins by category or status. */
export function toKml(places, { title = "Reel Eats" } = {}) {
  const located = places.filter((p) => p.located && p.lat != null && p.lng != null);
  const marks = located.map((p) => {
    const lines = [
      [p.cuisine || p.category, p.city || p.city_hint].filter(Boolean).join(" · "),
      p.address,
      p.summary,
      p.dishes?.length ? `Try: ${p.dishes.join(", ")}` : "",
      p.tags?.length ? `Good for: ${p.tags.join(", ")}` : "",
      p.notes ? `My notes: ${p.notes}` : "",
      p.source_url ? `Reel: ${p.source_url}` : "",
      p.maps_url ? `Google Maps: ${p.maps_url}` : "",
    ].filter(Boolean);
    const data = {
      Category: p.category,
      Status: p.visit_status === "visited" ? "Visited" : "To try",
      Cuisine: p.cuisine || "",
      "My rating": p.my_rating || "",
      "Google rating": p.rating || "",
      Tags: (p.tags || []).join(", "),
      Reel: p.source_url || "",
      "Google Maps": p.maps_url || "",
      Website: p.website || "",
    };
    return `    <Placemark>
      <name>${xml(p.name)}</name>
      <styleUrl>#${p.visit_status === "visited" ? "visited" : "want"}</styleUrl>
      <description>${cdata(lines.join("\n"))}</description>
      <ExtendedData>
${Object.entries(data)
  .map(([k, v]) => `        <Data name="${xml(k)}"><value>${xml(v)}</value></Data>`)
  .join("\n")}
      </ExtendedData>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`;
  });
  const style = (id, color) => `    <Style id="${id}"><IconStyle><color>${color}</color><Icon><href>https://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(title)}</name>
${style("want", "ff6b30b3")}
${style("visited", "ff557a2f")}
${marks.join("\n")}
  </Document>
</kml>
`;
}
