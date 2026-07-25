import { useCallback, useEffect, useRef, useState } from 'react';
import { CAMERA_MAX_LEVEL, CAMERA_MIN_LEVEL, clamp } from '../iso';

/** Per-frame lerp of the eased camera toward the detent the viewer picked. Fast enough that a zoom
 *  reads as one move, slow enough that the chain visibly travels rather than teleports. */
const CAMERA_LERP = 0.18;

/** Where the level is remembered between visits. This thing lives on a wall display; the camera the
 *  viewer left it at is part of how they set the display up, not a per-session preference. */
const STORAGE_KEY = 'fw.camera';

export interface CameraControl {
  /** Eased, continuous level — feed to `cameraFor`. */
  level: number;
  /** The detent being eased toward (integer). Drives the control's pips. */
  target: number;
  /** Jump to a detent (clamped). */
  setLevel: (level: number) => void;
  /** Step in (-1) or out (+1). */
  step: (delta: number) => void;
}

/** Initial detent: `?zoom=` wins (reproducible screenshots, same convention as `?focus=` / `?open=`),
 *  then whatever was last left on this display, then the hero view. */
function initialLevel(): number {
  const p = new URLSearchParams(window.location.search).get('zoom');
  const fromUrl = p != null ? parseInt(p, 10) : NaN;
  if (Number.isFinite(fromUrl)) return clamp(fromUrl, CAMERA_MIN_LEVEL, CAMERA_MAX_LEVEL);
  try {
    const saved = parseInt(window.localStorage.getItem(STORAGE_KEY) ?? '', 10);
    if (Number.isFinite(saved)) return clamp(saved, CAMERA_MIN_LEVEL, CAMERA_MAX_LEVEL);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The hero view is a fine default.
  }
  return CAMERA_MIN_LEVEL;
}

/**
 * The viewer-set camera distance. Holds the chosen detent and eases a continuous level toward it,
 * running a rAF loop ONLY while the two differ — at rest this hook costs nothing, which matters
 * because its consumer re-renders on every frame it publishes.
 */
export function useCamera(reducedMotion: boolean): CameraControl {
  const [target, setTarget] = useState<number>(initialLevel);
  const [level, setLevelState] = useState<number>(target);
  const levelRef = useRef(level);
  // Stepping reads the TARGET, not the eased level: two quick clicks on − must move two detents, and
  // the eased value is still down near the old one when the second lands.
  const targetRef = useRef(target);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  const setLevel = useCallback((l: number) => {
    const next = clamp(Math.round(l), CAMERA_MIN_LEVEL, CAMERA_MAX_LEVEL);
    targetRef.current = next;
    setTarget(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Non-fatal: the camera still works, it just won't survive a reload.
    }
  }, []);

  const step = useCallback((delta: number) => setLevel(targetRef.current + delta), [setLevel]);

  useEffect(() => {
    if (reducedRef.current) {
      levelRef.current = target;
      setLevelState(target);
      return;
    }
    let raf = 0;
    const tick = () => {
      const next = levelRef.current + (target - levelRef.current) * CAMERA_LERP;
      const done = Math.abs(target - next) < 0.002;
      levelRef.current = done ? target : next;
      setLevelState(levelRef.current);
      if (!done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return { level, target, setLevel, step };
}
