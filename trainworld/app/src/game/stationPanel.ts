// Which station the station board (ui/inspector/StationPanel.tsx) is open for: a station's id, null closed. Apart
// from the panel so the station inspector can open it without importing it.

import { signal } from "@preact/signals";

export const stationPanelShown = signal<string | null>(null);
