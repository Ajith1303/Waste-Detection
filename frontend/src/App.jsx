import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import MonitorPage from './pages/MonitorPage';
import LiveViewPage from './pages/LiveViewPage';
import DashboardPage from './pages/DashboardPage';
import ZoneConfigPage from './pages/ZoneConfigPage';
import RegisterPage from './pages/RegisterPage';
import { isMobileDevice } from './device';

export default function App() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Phone/tablet = camera only. PC = control room (Live View etc.).
    setIsMobile(isMobileDevice());
  }, []);

  return (
    <div>
      <nav className="navbar">
        <span className="brand">♻️ Smart Waste Detect</span>
        <NavLink to="/" end>Monitor</NavLink>
        {!isMobile && <NavLink to="/live">Live View</NavLink>}
        {!isMobile && <NavLink to="/dashboard">Admin Dashboard</NavLink>}
        {!isMobile && <NavLink to="/zones">Zone Config</NavLink>}
        <NavLink to="/register">Register</NavLink>
      </nav>

      <main className="container">
        <Routes>
          <Route path="/" element={<MonitorPage />} />
          <Route
            path="/live"
            element={isMobile
              ? <Navigate to="/" replace />
              : <LiveViewPage />}
          />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/zones" element={<ZoneConfigPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Routes>
      </main>
    </div>
  );
}