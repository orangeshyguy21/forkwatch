import { useEffect } from 'react';
import { IsometricChain } from './components/IsometricChain';
import { Header } from './components/Header';
import { useChainSocket } from './hooks/useChainSocket';
import { useStore } from './store';

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const state = useStore((s) => s.state);
  const stateError = useStore((s) => s.stateError);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Live tab title: "Forkwatch | 143 blocks" while counting down, "| Chain split ⚡" once it hits.
  useEffect(() => {
    const sf = state?.scheduled_fork;
    let suffix: string | null = null;
    if (state?.split) {
      suffix = 'Chain split ⚡';
    } else if (sf && !sf.reached) {
      const n = sf.blocks_until;
      suffix = `${n.toLocaleString()} block${n === 1 ? '' : 's'}`;
    }
    document.title = suffix ? `Forkwatch | ${suffix}` : 'Forkwatch';
  }, [state?.split, state?.scheduled_fork]);

  useChainSocket();

  return (
    <div className="fw-app flex flex-col overflow-hidden">
      <Header state={state} error={stateError} />
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <IsometricChain />
      </main>
    </div>
  );
}
