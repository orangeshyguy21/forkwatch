import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { PushFrame } from '../types';

// Opens the same-origin WebSocket. The backend pushes the payload itself — chain state plus the
// newest blocks — so a new block costs zero HTTP requests. The old contract (a bare ping that
// triggered three fetches per client per block) made origin traffic scale linearly with audience.
//
// The state poll is a FALLBACK, not a heartbeat: it runs only while the socket is down, and backs
// off. Polling alongside a healthy socket duplicates what the push already delivered.
const POLL_MIN_MS = 3000;
const POLL_MAX_MS = 30000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// A connection must stay up this long before it counts as healthy enough to reset the backoff.
// Resetting on `onopen` instead makes backoff useless against the case that matters: an origin that
// completes the handshake and then immediately drops it (crash-looping backend, overloaded box)
// would return every client to the 1s floor forever, i.e. a fixed-rate retry storm.
const STABLE_AFTER_MS = 15000;

export function useChainSocket() {
  const refreshState = useStore((s) => s.refreshState);
  const refreshTop = useStore((s) => s.refreshTop);
  const refreshRecent = useStore((s) => s.refreshRecent);
  const applyPush = useStore((s) => s.applyPush);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;
    let reconnectDelay = RECONNECT_MIN_MS;
    let pollDelay = POLL_MIN_MS;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    const clearStable = () => {
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
    };

    // Uniform in [half the floor, ceiling] rather than exactly `ceiling`. Without jitter every
    // client that lost the same backend wakes on the same tick, so a restart produces synchronized
    // reconnect waves at 1s, 2s, 4s... — the recovery becomes its own load spike, which is exactly
    // when the origin can least afford one.
    const jittered = (ceiling: number) =>
      Math.round(RECONNECT_MIN_MS / 2 + Math.random() * ceiling);

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws`);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        pollDelay = POLL_MIN_MS;
        // Deliberately NOT resetting reconnectDelay here — see STABLE_AFTER_MS. Only a connection
        // that survives counts as success; one that is accepted and dropped must keep backing off.
        clearStable();
        stableTimer = setTimeout(() => {
          reconnectDelay = RECONNECT_MIN_MS;
          stableTimer = null;
        }, STABLE_AFTER_MS);
      };

      ws.onmessage = (ev) => {
        let frame: PushFrame | null = null;
        try {
          frame = JSON.parse(String(ev.data)) as PushFrame;
        } catch {
          frame = null;
        }
        // Fall back to HTTP only when the frame carried no usable payload (ingest has not polled
        // yet) or left a hole in the recent window — not on every push.
        if (!frame || applyPush(frame)) {
          void refreshState();
          void refreshTop();
          void refreshRecent();
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        clearStable();
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    const scheduleReconnect = () => {
      if (closed || reconnectRef.current) return;
      const delay = jittered(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null;
        connect();
      }, delay);
    };

    connect();

    // Fallback poll: fires only while the socket is not open, and backs off the longer it stays
    // down. A healthy socket costs zero requests.
    const tick = () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        pollDelay = POLL_MIN_MS;
      } else {
        void refreshState();
        pollDelay = Math.min(Math.round(pollDelay * 1.5), POLL_MAX_MS);
      }
      // Spread the fallback poll too (±25%): while the socket is down this is the ONLY traffic
      // every client generates, so an unjittered interval marches them all in lockstep against an
      // origin that is, by definition, already unhealthy.
      pollTimer = setTimeout(tick, Math.round(pollDelay * (0.75 + Math.random() * 0.5)));
    };
    pollTimer = setTimeout(tick, pollDelay);

    return () => {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      clearStable();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [refreshState, refreshTop, refreshRecent, applyPush]);
}
