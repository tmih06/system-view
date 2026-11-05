import type { Tone } from "./types";

/**
 * Visual tokens for the diagram and the surrounding chrome.
 *
 * Metrics (font sizes, line heights, card sizes) are identical in every palette
 * because the layout pass measures with them; only paint differs. Consumers that
 * need stable geometry import {@link theme} (the light palette) for measurement,
 * while renderers accept a palette so a host can repaint without re-laying out.
 */
export interface ThemeTone {
  fill: string;
  stroke: string;
  ink: string;
}

export interface Theme {
  fontFamily: string;
  monoFamily: string;
  titleSize: number;
  titleLineHeight: number;
  subtitleSize: number;
  subtitleLineHeight: number;
  groupSize: number;
  edgeSize: number;
  cardSize: number;
  iconSize: number;
  /** Canvas backdrop for standalone exports. */
  background: string;
  grid: string;
  /** Node and card surface, distinct from the canvas backdrop. */
  surface: string;
  ink: string;
  muted: string;
  border: string;
  primary: string;
  secondary: string;
  tones: Record<Tone, ThemeTone>;
}

const metrics = {
  fontFamily: "Arial, Helvetica, sans-serif",
  monoFamily: "'Courier New', monospace",
  titleSize: 12,
  titleLineHeight: 17,
  subtitleSize: 9,
  subtitleLineHeight: 14,
  groupSize: 12,
  edgeSize: 10,
  cardSize: 64,
  iconSize: 48,
} as const;

/** Light palette; also the default and the source of measurement metrics. */
export const theme: Theme = {
  ...metrics,
  background: "#f9fbfe",
  grid: "#e6ebf2",
  surface: "#ffffff",
  ink: "#243243",
  muted: "#778495",
  border: "#d8e0e9",
  primary: "#2783b5",
  secondary: "#69788a",
  tones: {
    warm: { fill: "#fcf6ef", stroke: "#d5b895", ink: "#896137" },
    cool: { fill: "#eff6fd", stroke: "#b8cfe5", ink: "#4f7397" },
    neutral: { fill: "#f3f6fa", stroke: "#d0d9e3", ink: "#627186" },
  },
};

export type ThemeName = "light" | "dark";

/**
 * Dark palette. Group fills and surfaces stay low-contrast against the canvas
 * so the reference's tinted-panel look survives without glowing on black.
 */
export const darkTheme: Theme = {
  ...metrics,
  background: "#12161c",
  grid: "#1e242c",
  surface: "#1a2027",
  ink: "#e6edf5",
  muted: "#8b97a6",
  border: "#2c343e",
  primary: "#5cb4e0",
  secondary: "#93a1b3",
  tones: {
    warm: { fill: "#241d15", stroke: "#5b452c", ink: "#e0c9a6" },
    cool: { fill: "#141f2b", stroke: "#2c4358", ink: "#a9c9e4" },
    neutral: { fill: "#181d24", stroke: "#333c47", ink: "#a9b4c2" },
  },
};

export const themes: Record<ThemeName, Theme> = { light: theme, dark: darkTheme };
