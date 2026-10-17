import React, { useState, useEffect } from 'react';
import {
  Shield,
  Smartphone,
  Users,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  Server,
  Activity,
  Layers,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';

import DriverMobileView from './views/DriverMobileView';
import PassengerMobileView from './views/PassengerMobileView';
import AdminDashboardView from './views/AdminDashboardView';

export default function App() {
  // Top-Level Module Selector: 'DRIVER' | 'PASSENGER' | 'ADMIN'
  const [activeModule, setActiveModule] = useState('DRIVER');

  // Shared active vehicle selection across modules
  const [selectedVehicle, setSelectedVehicle] = useState('JK02-1234');

  // Mobile Mockup Frame Toggle (for Evaluators on Desktop)
  const [phoneFrameMode, setPhoneFrameMode] = useState(true);

  // Backend Health State
  const [backendStatus, setBackendStatus] = useState('CHECKING'); // 'CONNECTED' | 'OFFLINE'
  const [healthData, setHealthData] = useState(null);

  // Check Backend Health on Mount
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          const data = await res.json();
          setBackendStatus('CONNECTED');
          setHealthData(data);
        } else {
          setBackendStatus('OFFLINE');
        }
      } catch (e) {
        setBackendStatus('OFFLINE');
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 8000);
    return () => clearInterval(interval);
  }, []);

  const isMobileModule = activeModule === 'DRIVER' || activeModule === 'PASSENGER';

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--cvs-bg-primary)' }}>
      {/* ====================================================================
          Top Navigation Bar & Role Switcher (SRS §10 Modules)
          ==================================================================== */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'rgba(10, 14, 26, 0.95)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--glass-border)',
          padding: '8px 16px',
        }}
      >
        <div
          style={{
            maxWidth: '1440px',
            margin: '0 auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          {/* Logo & Platform Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, var(--cvs-accent-blue), var(--cvs-accent-cyan))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 12px rgba(59, 130, 246, 0.4)',
              }}
            >
              <Shield size={18} style={{ color: 'white' }} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.95rem', fontWeight: 900, letterSpacing: '-0.02em' }}>
                  CVS Edge AI
                </span>
                <span
                  style={{
                    fontSize: '0.6rem',
                    background: 'rgba(34, 211, 238, 0.15)',
                    color: 'var(--cvs-accent-cyan)',
                    padding: '1px 5px',
                    borderRadius: '4px',
                    fontWeight: 700,
                  }}
                >
                  PWA + Cloud
                </span>
              </div>
              <p style={{ fontSize: '0.62rem', color: 'var(--cvs-text-muted)' }}>
                Commercial Vehicle Safety & Tamper-Evident Blackbox
              </p>
            </div>
          </div>

          {/* Module Switcher Buttons */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'rgba(0, 0, 0, 0.5)',
              padding: '3px',
              borderRadius: '10px',
              border: '1px solid var(--glass-border)',
              gap: '2px',
            }}
          >
            {/* Module 1: Driver Mobile Unit */}
            <button
              onClick={() => setActiveModule('DRIVER')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background:
                  activeModule === 'DRIVER'
                    ? 'linear-gradient(135deg, var(--cvs-accent-blue), #2563eb)'
                    : 'transparent',
                color: activeModule === 'DRIVER' ? 'white' : 'var(--cvs-text-secondary)',
                boxShadow: activeModule === 'DRIVER' ? '0 2px 10px rgba(59, 130, 246, 0.4)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              <Smartphone size={14} />
              <span>Driver HUD</span>
              <span style={{ fontSize: '0.6rem', opacity: 0.8 }}>(10.1)</span>
            </button>

            {/* Module 2: Passenger Transit App */}
            <button
              onClick={() => setActiveModule('PASSENGER')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background:
                  activeModule === 'PASSENGER'
                    ? 'linear-gradient(135deg, var(--cvs-accent-green), #059669)'
                    : 'transparent',
                color: activeModule === 'PASSENGER' ? 'white' : 'var(--cvs-text-secondary)',
                boxShadow: activeModule === 'PASSENGER' ? '0 2px 10px rgba(16, 185, 129, 0.4)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              <Users size={14} />
              <span>Passenger App</span>
              <span style={{ fontSize: '0.6rem', opacity: 0.8 }}>(10.2)</span>
            </button>

            {/* Module 3: Fleet & Transport Authority Console */}
            <button
              onClick={() => setActiveModule('ADMIN')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '6px 12px',
                borderRadius: '8px',
                fontSize: '0.75rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background:
                  activeModule === 'ADMIN'
                    ? 'linear-gradient(135deg, var(--cvs-accent-purple), #7c3aed)'
                    : 'transparent',
                color: activeModule === 'ADMIN' ? 'white' : 'var(--cvs-text-secondary)',
                boxShadow: activeModule === 'ADMIN' ? '0 2px 10px rgba(139, 92, 246, 0.4)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              <LayoutDashboard size={14} />
              <span>Fleet Operations</span>
              <span style={{ fontSize: '0.6rem', opacity: 0.8 }}>(10.3)</span>
            </button>
          </div>

          {/* Controls: Vehicle Selector, Phone Frame Toggle, Backend Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Phone Mockup Frame Toggle (only for Driver/Passenger mobile modules) */}
            {isMobileModule && (
              <button
                onClick={() => setPhoneFrameMode(!phoneFrameMode)}
                className="btn btn-ghost"
                style={{ padding: '5px 8px', fontSize: '0.68rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                title={phoneFrameMode ? 'Expand to Fluid Full Width' : 'Constrain inside Smartphone Frame'}
              >
                {phoneFrameMode ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
                <span>{phoneFrameMode ? 'Full Width' : 'Phone Frame'}</span>
              </button>
            )}

            {/* Backend Connectivity Status Pill */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 8px',
                borderRadius: '100px',
                fontSize: '0.65rem',
                fontWeight: 600,
                background: backendStatus === 'CONNECTED' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${backendStatus === 'CONNECTED' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                color: backendStatus === 'CONNECTED' ? 'var(--cvs-safe)' : 'var(--cvs-critical)',
              }}
              title="FastAPI Cloud Backend Connectivity Status"
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: backendStatus === 'CONNECTED' ? 'var(--cvs-safe)' : 'var(--cvs-critical)',
                  animation: backendStatus === 'CONNECTED' ? 'pulse-green 2s infinite' : 'none',
                }}
              />
              <span>{backendStatus === 'CONNECTED' ? 'Cloud Sync Online' : 'Cloud Sync Offline'}</span>
            </div>
          </div>
        </div>
      </header>

      {/* ====================================================================
          Main Application Content View
          ==================================================================== */}
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: isMobileModule && phoneFrameMode ? 'center' : 'stretch',
          justifyContent: isMobileModule && phoneFrameMode ? 'center' : 'flex-start',
          padding: isMobileModule && phoneFrameMode ? '16px 8px' : '0',
          background: isMobileModule && phoneFrameMode ? 'radial-gradient(circle at center, #111827 0%, #060911 100%)' : 'transparent',
        }}
      >
        {isMobileModule && phoneFrameMode ? (
          /* Smartphone Mockup Container Frame */
          <div
            style={{
              width: '100%',
              maxWidth: '430px',
              minHeight: '780px',
              borderRadius: '42px',
              padding: '12px',
              background: '#020408',
              boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.85), 0 0 0 8px #1f293d, 0 0 0 10px #0a0e1a',
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Phone Dynamic Island / Camera Notch */}
            <div
              style={{
                width: '100px',
                height: '18px',
                background: '#0a0e1a',
                borderRadius: '12px',
                margin: '0 auto 10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#1e293b' }} />
              <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#22d3ee', opacity: 0.7 }} />
            </div>

            {/* Scrollable Mobile Viewport */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {activeModule === 'DRIVER' && (
                <DriverMobileView
                  selectedVehicle={selectedVehicle}
                  onVehicleChange={setSelectedVehicle}
                />
              )}
              {activeModule === 'PASSENGER' && (
                <PassengerMobileView
                  selectedVehicle={selectedVehicle}
                  onVehicleChange={setSelectedVehicle}
                />
              )}
            </div>

            {/* Phone Home Bar */}
            <div
              style={{
                width: '120px',
                height: '4px',
                background: 'rgba(255, 255, 255, 0.3)',
                borderRadius: '2px',
                margin: '10px auto 4px',
              }}
            />
          </div>
        ) : (
          /* Full Screen Responsive Rendering */
          <div style={{ width: '100%', height: '100%' }}>
            {activeModule === 'DRIVER' && (
              <div style={{ padding: '16px 8px' }}>
                <DriverMobileView
                  selectedVehicle={selectedVehicle}
                  onVehicleChange={setSelectedVehicle}
                />
              </div>
            )}
            {activeModule === 'PASSENGER' && (
              <div style={{ padding: '16px 8px' }}>
                <PassengerMobileView
                  selectedVehicle={selectedVehicle}
                  onVehicleChange={setSelectedVehicle}
                />
              </div>
            )}
            {activeModule === 'ADMIN' && (
              <AdminDashboardView selectedVehicle={selectedVehicle} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
