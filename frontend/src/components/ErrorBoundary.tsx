import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors so one bad frame cannot take the whole page down.
 *
 * Without a boundary, a single throw during render — a malformed 200 from /api/state, an
 * unexpected null in a chain-derived field, a block shape the UI did not anticipate — propagates
 * to the root and React unmounts the ENTIRE tree. That takes the WebSocket hook with it, so
 * nothing is left running to recover: the viewer sits on a permanently blank page until they
 * happen to reload. During a fork event, that is the product going dark exactly when it matters.
 *
 * The fallback keeps the page alive and makes recovery explicit. "Try again" re-mounts the tree,
 * which is enough when the offending data has since been replaced by a newer push; a reload is the
 * guaranteed escape hatch when it has not.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the detail in the console: the fallback deliberately does not render the stack, since
    // this is a public dashboard.
    console.error('[forkwatch] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-center text-neutral-200">
        <h1 className="text-lg font-semibold">Something went wrong rendering the chain view.</h1>
        <p className="max-w-md text-sm text-neutral-400">
          The connection to the node is unaffected — this is a display error. Retrying usually picks
          up the next update.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
