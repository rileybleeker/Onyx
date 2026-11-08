"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { NycLead } from "@/lib/nyc";

// Marker color = where the lead stands with Riley; full fits the scout
// surfaced but Riley hasn't judged yet stand out in amber.
export function markerColor(lead: NycLead): string {
  if (lead.riley === "Interested") return "#16E07A";
  if (lead.riley === "Toured") return "#9A7BFA";
  if (lead.riley === "Passed") return "#5F6368";
  if (lead.fit === "Full fit") return "#F5A623";
  if (lead.fit === "Meets numbers") return "#FFD23F";
  return "#9AA0A6";
}

const CENTRAL_PARK: L.LatLngExpression = [40.7812, -73.9665];

const money = (n: number | null) => (n == null ? "?" : `$${n.toLocaleString("en-US")}`);

export default function NycMap({
  leads,
  selectedId,
  onSelect,
}: {
  leads: NycLead[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(CENTRAL_PARK, 13);
    // Standard OSM tiles (keyless; CARTO's basemaps started demanding an API
    // key), darkened to match the app with a CSS filter on the tile pane.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: "nyc-dark-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Redraw markers whenever the filtered set or the selection changes.
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const placed = leads.filter((l) => l.lat != null && l.lng != null);
    // Draw the selected marker last so it sits on top.
    const ordered = [...placed].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
    for (const lead of ordered) {
      const selected = lead.id === selectedId;
      const gone = lead.status === "Gone";
      const marker = L.circleMarker([lead.lat!, lead.lng!], {
        radius: selected ? 10 : 6,
        color: selected ? "#E8EAED" : markerColor(lead),
        weight: selected ? 3 : 1.5,
        fillColor: markerColor(lead),
        fillOpacity: gone ? 0.15 : 0.85,
      });
      marker.bindTooltip(
        `<b>${lead.number ?? ""}</b> ${escapeHtml(lead.address)}<br/>${money(lead.price)} · ${lead.sqft ?? "?"} sq ft · ${lead.walkMin ?? "?"} min`,
        { direction: "top", offset: [0, -6] }
      );
      marker.on("click", () => onSelectRef.current(lead.id));
      marker.addTo(g);
    }
    if (!fitted.current && placed.length) {
      m.fitBounds(L.latLngBounds(placed.map((l) => [l.lat!, l.lng!] as L.LatLngTuple)), { padding: [24, 24], maxZoom: 14 });
      fitted.current = true;
    }
  }, [leads, selectedId]);

  // Pan to a lead picked from the table.
  useEffect(() => {
    const lead = leads.find((l) => l.id === selectedId);
    if (map.current && lead?.lat != null && lead.lng != null) {
      map.current.panTo([lead.lat, lead.lng], { animate: true });
    }
  }, [selectedId, leads]);

  return (
    <>
      <style>{`.nyc-dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6); }`}</style>
      <div ref={el} className="h-[420px] w-full rounded-[4px] overflow-hidden bg-surface" aria-label="Map of leads" />
    </>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
