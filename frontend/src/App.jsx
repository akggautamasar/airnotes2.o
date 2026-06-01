import React, { useState, useEffect, useRef } from 'react';
import { AppProvider, useApp } from './store/AppContext';
import LoginPage from './pages/LoginPage';
import MainApp from './pages/MainApp';
import WakeUpScreen from './components/WakeUpScreen';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function AppInner() {
  const { state } = useApp();
  return state.isAuthenticated ? <MainApp /> : <LoginPage />;
}

function useServerStatus() {
  // 'checking' | 'waking' | 'ready'
  const [status, setStatus] = useState('checking');
  const timerRef = useRef(null);

  useEffect(() => {
    // Skip check in local dev (relative URL)
    if (!API_BASE.startsWith('http')) {
      setStatus('ready');
      return;
    }

    const pingUrl = API_BASE.replace(/\/api\/?$/, '') + '/ping';

    async function check() {
      try {
        await fetch(pingUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(8000),
        });
        // Any response means the server is alive
        setStatus('ready');
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      } catch {
        // Network error / timeout = server is sleeping or suspended
        setStatus('waking');
      }
    }

    check();
    timerRef.current = setInterval(check, 5000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return status;
}

export default function App() {
  const serverStatus = useServerStatus();

  if (serverStatus !== 'ready') {
    return <WakeUpScreen waking={serverStatus === 'waking'} />;
  }

  return <AppProvider><AppInner /></AppProvider>;
}
