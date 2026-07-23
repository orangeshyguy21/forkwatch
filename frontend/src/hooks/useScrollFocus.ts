import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FOCUS_LERP,
  FOCUS_LERP_SCROLL,
  MAX_SCROLL_SPEED,
  SCROLL_ACCEL_MAX,
  SCROLL_ACCEL_RESET_MS,
  SCROLL_ACCEL_STEP,
  SCROLL_FRICTION_ACTIVE,
  SCROLL_FRICTION_RELEASE,
  SCROLL_MVEL_EPS,
  SCROLL_SETTLE_MS,
  WHEEL_SENS,
  ZOOM_LERP,
  clamp,
  velocityToZoom,
} from '../iso';

export interface ScrollFocus {
  /** Attach to the chain viewport (wheel is intercepted here). */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Eased fractional height currently at the focus anchor. */
  focusHeight: number;
  /** The height the focus is easing toward (drives the scrollbar thumb). */
  target: number;
  /** Velocity-driven zoom spring, 1 (idle) .. ZOOM_MAX (flying). */
  zoom: number;
  /** Smoothed focus velocity in heights/frame (signed). */
  velocity: number;
  /** True when parked at/near the chain tip. */
  atTip: boolean;
  /** Set the eased target height. ease=false snaps instantly (no glide). */
  setTarget: (h: number, ease?: boolean) => void;
  /** Move the target by a relative number of heights (keyboard nudge). */
  nudge: (delta: number) => void;
}

interface Params {
  tipHeight: number | null;
  pruneFloor: number | null;
  reducedMotion: boolean;
  /** Initial focus height; null means "start at tip". Applied once. */
  initialFocus: number | null;
}

/**
 * Virtual-focus scroller. Wheel/keyboard/scrollbar set an eased `target` height;
 * a rAF loop lerps `focusHeight` toward it (buttery, progressive, decelerating)
 * and springs a global zoom from focus velocity. No native scrollbar is used.
 * Newest (tip) is up; oldest (prune floor) is down.
 */
export function useScrollFocus({
  tipHeight,
  pruneFloor,
  reducedMotion,
  initialFocus,
}: Params): ScrollFocus {
  const scrollRef = useRef<HTMLDivElement>(null);

  const tipRef = useRef<number | null>(tipHeight);
  const floorRef = useRef<number | null>(pruneFloor);
  const reducedRef = useRef(reducedMotion);
  const initialFocusRef = useRef(initialFocus);
  tipRef.current = tipHeight;
  floorRef.current = pruneFloor;
  reducedRef.current = reducedMotion;
  initialFocusRef.current = initialFocus;

  const targetRef = useRef<number>(initialFocus ?? tipHeight ?? 0);
  const focusRef = useRef<number>(initialFocus ?? tipHeight ?? 0);
  const velRef = useRef(0);
  const zoomRef = useRef(1);
  const seededRef = useRef(false);
  const interactedRef = useRef(false); // true once the user scrolls/keys/seeks

  // Scroll momentum + acceleration state.
  const mvelRef = useRef(0); // momentum: heights/frame added to the target
  const accelRef = useRef(1); // acceleration multiplier from consecutive same-dir ticks
  const lastWheelDirRef = useRef(0);
  const lastWheelTimeRef = useRef(0);
  const settleUntilRef = useRef(0); // wall-clock ms until which the detent stays suppressed

  const [focusHeight, setFocusHeight] = useState<number>(initialFocus ?? tipHeight ?? 0);
  const [target, setTargetState] = useState<number>(initialFocus ?? tipHeight ?? 0);
  const [zoom, setZoom] = useState(1);
  const [velocity, setVelocity] = useState(0);
  const [atTip, setAtTip] = useState(true);

  // Mirrors of last-pushed state so the loop can diff without re-subscribing.
  const focusPushed = useRef(focusHeight);
  const targetPushed = useRef(target);
  const zoomPushed = useRef(zoom);
  const velPushed = useRef(velocity);
  const atTipPushed = useRef(atTip);

  const clampTarget = useCallback((h: number): number => {
    const tip = tipRef.current;
    const floor = floorRef.current;
    if (tip == null || floor == null) return h;
    return clamp(h, floor, tip);
  }, []);

  const setTarget = useCallback(
    (h: number, ease = true) => {
      interactedRef.current = true;
      // An explicit seek (scrollbar / key / jump) cancels any wheel momentum and lets the detent
      // settle immediately — it must not fight the glide.
      mvelRef.current = 0;
      accelRef.current = 1;
      settleUntilRef.current = 0;
      targetRef.current = clampTarget(h);
      if (!ease) focusRef.current = targetRef.current;
    },
    [clampTarget],
  );

  const nudge = useCallback(
    (delta: number) => {
      setTarget(Math.round(targetRef.current) + delta, true);
    },
    [setTarget],
  );

  // Intercept wheel into the eased target (progressive, momentum-friendly).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (tipRef.current == null || floorRef.current == null) return;
      e.preventDefault();
      interactedRef.current = true;
      // Normalize wheel units: 0=pixel, 1=line, 2=page.
      const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const raw = e.deltaY * factor;
      const dir = Math.sign(raw);
      if (dir === 0) return;

      const now = performance.now();
      const gap = now - lastWheelTimeRef.current;
      if (dir !== lastWheelDirRef.current || gap > SCROLL_ACCEL_RESET_MS) {
        // Fresh gesture (or a reversal): reset acceleration and drop any opposing momentum so the
        // flip is instantly responsive.
        accelRef.current = 1;
        if (dir !== lastWheelDirRef.current) mvelRef.current = 0;
      } else {
        // Continuing the same-direction scroll: ramp up.
        accelRef.current = Math.min(accelRef.current + SCROLL_ACCEL_STEP, SCROLL_ACCEL_MAX);
      }
      lastWheelDirRef.current = dir;
      lastWheelTimeRef.current = now;

      // Reduced motion: no momentum/glide — move the target directly and let it snap.
      if (reducedRef.current) {
        targetRef.current = clampTarget(targetRef.current - raw * WHEEL_SENS * accelRef.current);
        return;
      }
      settleUntilRef.current = now + SCROLL_SETTLE_MS; // keep the flight live + suppress the detent
      // deltaY > 0 (scroll down) moves the focus toward older/lower heights. Each tick shoves speed
      // harder as acceleration ramps; the running speed is capped so a fast fly stays controllable.
      const next = mvelRef.current - raw * WHEEL_SENS * accelRef.current;
      mvelRef.current = clamp(next, -MAX_SCROLL_SPEED, MAX_SCROLL_SPEED);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clampTarget]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const tip = tipRef.current;
      const floor = floorRef.current;
      if (tip == null || floor == null) return;

      // Seed once when the range first becomes known.
      if (!seededRef.current) {
        const seed = clamp(initialFocusRef.current ?? tip, floor, tip);
        targetRef.current = seed;
        focusRef.current = seed;
        seededRef.current = true;
      }

      // Until the user interacts (and unless an explicit ?focus was given), keep the target glued to
      // the tip. This robustly follows the tip loading in from 0 without racing the atTip flag.
      if (initialFocusRef.current == null && !interactedRef.current) {
        targetRef.current = tip;
      }

      // The wheel is "live" for a short window after each tick. While live the speed is only lightly
      // damped (it sustains + accumulates as you keep scrolling); once quiet it's damped hard so the
      // flight decays and settles onto a block quickly.
      const live = !reducedRef.current && now < settleUntilRef.current;
      const prevTarget = targetRef.current;
      if (mvelRef.current !== 0) {
        targetRef.current += mvelRef.current;
        if (targetRef.current <= floor || targetRef.current >= tip) mvelRef.current = 0;
        mvelRef.current *= live ? SCROLL_FRICTION_ACTIVE : SCROLL_FRICTION_RELEASE;
        if (Math.abs(mvelRef.current) < SCROLL_MVEL_EPS) mvelRef.current = 0;
      }

      targetRef.current = clamp(targetRef.current, floor, tip);
      const snapped = clamp(Math.round(targetRef.current), floor, tip);

      // Detent debounce: while the flight is live (or speed still glides) the focus tracks the FREE
      // continuous target, so scrolling never fights a snap. Once the wheel has been quiet past
      // SCROLL_SETTLE_MS and speed has died, the focus eases onto the NEAREST block (the detent) —
      // there is no resting state hovering between two blocks.
      const scrolling = !reducedRef.current && (live || mvelRef.current !== 0);
      const focusTarget = scrolling ? targetRef.current : snapped;
      const prevFocus = focusRef.current;
      const lerp = reducedRef.current ? 0.5 : scrolling ? FOCUS_LERP_SCROLL : FOCUS_LERP;
      focusRef.current += (focusTarget - focusRef.current) * lerp;
      if (!scrolling) {
        // Snap when essentially arrived, and pull the continuous target onto the block too so the next
        // scroll resumes from a clean integer.
        if (Math.abs(snapped - focusRef.current) < 0.002) {
          focusRef.current = snapped;
          targetRef.current = snapped;
        }
      }

      // Zoom is driven by ACTUAL scroll speed (how far the target moved this frame), lightly smoothed,
      // NOT by the lagged focus velocity — so the further/faster you scroll, the smaller the blocks get
      // right away, and the zoom holds while the flight is sustained instead of flickering per notch.
      const rawVel = scrolling ? targetRef.current - prevTarget : focusRef.current - prevFocus;
      velRef.current += (rawVel - velRef.current) * 0.5;
      const vSmoothed = velRef.current;

      const targetZoom = reducedRef.current ? 1 : velocityToZoom(vSmoothed);
      // Rise fast (snap out as you scroll), fall gently (ease back when you stop).
      const zLerp = targetZoom > zoomRef.current ? Math.min(1, ZOOM_LERP * 2.4) : ZOOM_LERP;
      zoomRef.current += (targetZoom - zoomRef.current) * zLerp;
      if (reducedRef.current) zoomRef.current = 1;

      const nearTip = snapped >= tip;

      if (
        Math.abs(focusRef.current - focusPushed.current) > 0.002 ||
        Math.abs(snapped - targetPushed.current) > 0.01 ||
        Math.abs(zoomRef.current - zoomPushed.current) > 0.003 ||
        Math.abs(vSmoothed - velPushed.current) > 0.01 ||
        nearTip !== atTipPushed.current
      ) {
        focusPushed.current = focusRef.current;
        targetPushed.current = snapped;
        zoomPushed.current = zoomRef.current;
        velPushed.current = vSmoothed;
        atTipPushed.current = nearTip;
        setFocusHeight(focusRef.current);
        setTargetState(snapped);
        setZoom(zoomRef.current);
        setVelocity(vSmoothed);
        setAtTip(nearTip);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return { scrollRef, focusHeight, target, zoom, velocity, atTip, setTarget, nudge };
}
