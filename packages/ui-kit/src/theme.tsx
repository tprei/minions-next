import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  prefersDark,
  prefersReducedMotion,
  readStoredMode,
  readStoredMotion,
  ThemeContext,
  motionStorageKey,
  themeStorageKey,
  type MotionMode,
  type ResolvedTheme,
  type ThemeContextValue,
  type ThemeMode,
} from "./theme-context.js";

/**
 * Wraps the app once, near the root. Sets `data-theme`/`data-reduced-motion` on `<html>`
 * (tokens.css keys off those exact attributes) and keeps them in sync with both the stored
 * operator preference and live OS-level media-query changes (PR 43, PRD UI-09).
 */
export function ThemeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [motion, setMotionState] = useState<MotionMode>(readStoredMotion);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);
  const [systemReducedMotion, setSystemReducedMotion] = useState<boolean>(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onDarkChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    const onMotionChange = (event: MediaQueryListEvent): void => {
      setSystemReducedMotion(event.matches);
    };
    darkQuery.addEventListener("change", onDarkChange);
    motionQuery.addEventListener("change", onMotionChange);
    return () => {
      darkQuery.removeEventListener("change", onDarkChange);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  const reducedMotion = motion === "reduced" || systemReducedMotion;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-reduced-motion", String(reducedMotion));
  }, [resolved, reducedMotion]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    window.localStorage.setItem(themeStorageKey, next);
  }, []);

  const setMotion = useCallback((next: MotionMode) => {
    setMotionState(next);
    window.localStorage.setItem(motionStorageKey, next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, motion, reducedMotion, setMode, setMotion }),
    [mode, resolved, motion, reducedMotion, setMode, setMotion],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
