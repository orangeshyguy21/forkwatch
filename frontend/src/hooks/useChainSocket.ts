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
        reconnectDelay = RECONNECT_MIN_MS;
        pollDelay = POLL_MIN_MS;
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
      const delay = reconnectDelay;
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
      pollTimer = setTimeout(tick, pollDelay);
    };
    pollTimer = setTimeout(tick, pollDelay);

    return () => {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
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
