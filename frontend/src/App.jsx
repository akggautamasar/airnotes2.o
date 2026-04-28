import React from 'react';
import { AppProvider, useApp } from './store/AppContext';
import LoginPage from './pages/LoginPage';
import MainApp from './pages/MainApp';

function AppInner() {
  const { state } = useApp();
  return state.isAuthenticated ? <MainApp /> : <LoginPage />;
}

export default function App() {
  return <AppProvider><AppInner /></AppProvider>;
}
