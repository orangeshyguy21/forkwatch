import { useEffect, useRef } from 'react';
import { useStore } from '../store';

// Opens the same-origin WebSocket. On any message we refetch /api/state and the
// top page of /api/blocks. A 3s poll of /api/state is kept as a resilient fallback.
export function useChainSocket() {
  const refreshState = useStore((s) => s.refreshState);
  const refreshTop = useStore((s) => s.refreshTop);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;

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

      ws.onmessage = () => {
        // Contract: on any push, refetch state + the top page.
        void refreshState();
        void refreshTop();
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
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null;
        connect();
      }, 3000);
    };

    connect();

    // Fallback poll of state every 3s in case the socket is down.
    const poll = setInterval(() => {
      void refreshState();
    }, 3000);

    return () => {
      closed = true;
      clearInterval(poll);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [refreshState, refreshTop]);
}
