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

  useChainSocket();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header state={state} error={stateError} />
      <main className="flex min-h-0 flex-1 overflow-hidden">
        <IsometricChain />
      </main>
    </div>
  );
}
