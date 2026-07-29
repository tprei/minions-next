import { createContext, useContext } from "react";

/**
 * Theme context, types, and the `useTheme` hook (PR 43 — ui-design-system-shell, PRD UI-09).
 * Split out of theme.tsx so that file exports only the `ThemeProvider` component (Fast
 * Refresh requires component-only modules).
 */
export type ThemeMode = "light" | "dark" | "system";
export type MotionMode = "system" | "reduced";
export type ResolvedTheme = "light" | "dark";

export const themeStorageKey = "mn-theme-mode";
export const motionStorageKey = "mn-motion-mode";

export interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
  readonly motion: MotionMode;
  readonly reducedMotion: boolean;
  readonly setMode: (mode: ThemeMode) => void;
  readonly setMotion: (motion: MotionMode) => void;
}

export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(themeStorageKey);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function readStoredMotion(): MotionMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(motionStorageKey);
  return stored === "reduced" ? "reduced" : "system";
}

export function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) {
    throw new Error("useTheme must be called within a ThemeProvider");
  }
  return value;
}
