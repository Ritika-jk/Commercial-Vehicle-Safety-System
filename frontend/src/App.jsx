import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Gauge,
  Navigation,
  Radio,
  Wifi,
  WifiOff,
  Mountain,
  AlertTriangle,
  CheckCircle2,
  Play,
  Pause,
  Square,
  RotateCcw,
  Smartphone,
  MonitorSmartphone,
  Compass,
  Activity,
  Satellite,
  Timer,
  Shield,
  ChevronDown,
  Zap,
  MapPin,
  Eye,
  Crosshair,
} from 'lucide-react';
import sensorEngine, { SensorMode } from './services/sensors/sensorFusion';
import gisEngine from './services/engine/offlineGisEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCoord(val, decimals = 6) {
  return val != null && Number.isFinite(val) ? val.toFixed(decimals) : '—';
}

function formatSpeed(kmh) {
  return kmh != null && Number.isFinite(kmh) ? Math.round(kmh) : 0;
}

function getSensorModeLabel(mode) {
  switch (mode) {
    case SensorMode.GPS_LOCKED: return 'GPS Locked';
    case SensorMode.IMU_DEAD_RECKONING: return 'IMU Dead-Reckoning';
    case SensorMode.SIMULATION: return 'Simulation';
    case SensorMode.OFFLINE: return 'Offline';
    default: return mode;
  }
}

function getSensorModeBadgeClass(mode) {
  switch (mode) {
    case SensorMode.GPS_LOCKED: return 'sensor-badge--gps';
    case SensorMode.IMU_DEAD_RECKONING: return 'sensor-badge--dr';
    case SensorMode.SIMULATION: return 'sensor-badge--sim';
    default: return 'sensor-badge--offline';
  }
}

function getRiskColor(risk) {
  switch (risk) {
    case 'CRITICAL': return 'var(--cvs-critical)';
    case 'ADVISORY': return 'var(--cvs-advisory)';
    case 'SAFE': return 'var(--cvs-safe)';
    default: return 'var(--cvs-text-muted)';
  }
}

function getSpeedColor(actual, safe) {
  if (safe == null) return 'var(--cvs-safe)';
  const delta = actual - safe;
  if (delta > 15) return 'var(--cvs-critical)';
  if (delta > 5) return 'var(--cvs-advisory)';
  return 'var(--cvs-safe)';
}

// ---------------------------------------------------------------------------
// App Component
// ---------------------------------------------------------------------------

export default function App() {
  const [sensorState, setSensorState] = useState(sensorEngine.getState());
  const [gisResult, setGisResult] = useState(null);
  const [gisReady, setGisReady] = useState(false);
  const [gisInfo, setGisInfo] = useState(null);
  const [isStarted, setIsStarted] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [simProgress, setSimProgress] = useState({ index: 0, total: 0, label: '' });
  const [simPaused, setSimPaused] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showTelemetry, setShowTelemetry] = useState(false);

  const gisIntervalRef = useRef(null);
  const logEndRef = useRef(null);

  // Add a log entry
  const addLog = useCallback((msg, level = 'info') => {
    setLogs((prev) => {
      const next = [...prev, { time: new Date().toLocaleTimeString(), msg, level }];
      return next.length > 80 ? next.slice(-60) : next;
    });
  }, []);

  // --- Initialise GIS Engine on mount ---
  useEffect(() => {
    gisEngine.initialize('jk_nh44').then((info) => {
      setGisReady(true);
      setGisInfo(info);
      addLog(`GIS Engine ready — ${info.featureCount} curve features, ${info.routePointCount} route pts (${info.source})`, 'success');
    }).catch((err) => {
      addLog(`GIS init failed: ${err.message}`, 'error');
    });
  }, [addLog]);

  // --- Sensor state listener ---
  useEffect(() => {
    const unsubState = sensorEngine.on('stateUpdate', (state) => {
      setSensorState(state);
    });

    const unsubMode = sensorEngine.on('modeChange', ({ from, to }) => {
      addLog(`Sensor mode: ${from} → ${to}`, to === SensorMode.IMU_DEAD_RECKONING ? 'warning' : 'info');
    });

    const unsubHarsh = sensorEngine.on('harshCornering', ({ lateralG, speedKmh }) => {
      addLog(`⚠ Harsh cornering detected! ${lateralG.toFixed(2)}g at ${speedKmh.toFixed(0)} km/h`, 'error');
    });

    const unsubDrTimeout = sensorEngine.on('drTimeout', () => {
      addLog('⏰ Dead-reckoning 30s grace window expired — confidence degraded', 'warning');
    });

    const unsubGpsRestored = sensorEngine.on('gpsRestored', () => {
      addLog('🛰 GPS signal restored — switching back to GPS_LOCKED', 'success');
    });

    return () => {
      unsubState();
      unsubMode();
      unsubHarsh();
      unsubDrTimeout();
      unsubGpsRestored();
    };
  }, [addLog]);

  // --- GIS evaluation loop (4 Hz when active) ---
  useEffect(() => {
    if (isStarted && gisReady) {
      gisIntervalRef.current = setInterval(() => {
        const s = sensorEngine.getState();
        if (s.lat !== 0 && s.lon !== 0) {
          const result = gisEngine.evaluateUpcomingRoad(
            s.lat, s.lon, s.speedKmh, s.heading, s.sensorMode,
          );
          setGisResult(result);
        }
      }, 250);
    }
    return () => {
      if (gisIntervalRef.current) clearInterval(gisIntervalRef.current);
    };
  }, [isStarted, gisReady]);

  // --- Auto-scroll logs ---
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // --- Handlers ---
  const handleStartShift = async () => {
    addLog('Starting shift — requesting sensor permissions…');
    const result = await sensorEngine.requestPermissionsAndStart();
    setIsStarted(true);
    addLog(`GPS: ${result.gps ? '✓' : '✗'}  IMU: ${result.imu ? '✓' : '✗'}`, result.gps ? 'success' : 'warning');
  };

  const handleCalibrate = () => {
    sensorEngine.calibrateMount();
    addLog('✓ Mount calibrated — pitch/roll offsets zeroed', 'success');
  };

  const handleToggleSimulation = () => {
    const newSim = !isSimulation;
    setIsSimulation(newSim);
    sensorEngine.setSimulationMode(newSim);
    setIsStarted(true);

    if (newSim) {
      addLog('🏔 Simulation Mode — NH44 Mountain Drive activated', 'info');
      const sim = sensorEngine.getSimulator();
      if (sim) {
        sim.on('waypoint', ({ index, total, waypoint }) => {
          setSimProgress({ index, total, label: waypoint.label });
        });
        sim.on('tunnelEnter', () => addLog('🔴 TUNNEL — GPS signal lost, switching to IMU dead-reckoning', 'warning'));
        sim.on('tunnelExit', () => addLog('🟢 TUNNEL EXIT — GPS signal restored', 'success'));
        sim.on('complete', () => {
          addLog('✓ Simulation complete — all waypoints replayed', 'success');
          setSimProgress((p) => ({ ...p, label: 'Simulation Complete' }));
        });
      }
    } else {
      addLog('📡 Live Phone Sensors — real GPS/IMU active', 'info');
      setSimProgress({ index: 0, total: 0, label: '' });
    }
  };

  const handleSimPause = () => {
    const sim = sensorEngine.getSimulator();
    if (sim) {
      sim.togglePause();
      setSimPaused(!simPaused);
    }
  };

  const handleSimRestart = () => {
    const sim = sensorEngine.getSimulator();
    if (sim) {
      sim.stop();
      sim.start();
      setSimPaused(false);
      addLog('🔄 Simulation restarted from waypoint 0', 'info');
    }
  };

  const handleStop = () => {
    sensorEngine.stop();
    setIsStarted(false);
    setIsSimulation(false);
    setSimPaused(false);
    setGisResult(null);
    addLog('⏹ Shift ended — all sensors stopped', 'info');
  };

  // --- Derived UI values ---
  const speed = formatSpeed(sensorState.speedKmh);
  const safeSpeed = gisResult?.safeSpeedKmh;
  const speedColor = getSpeedColor(sensorState.speedKmh, safeSpeed);
  const riskLevel = gisResult?.riskLevel || 'SAFE';
  const riskColor = getRiskColor(riskLevel);
  const confidence = Math.round((sensorState.confidence || 0) * 100);

  return (
    <div style={{ minHeight: '100dvh', padding: '12px', maxWidth: '480px', margin: '0 auto' }}>

      {/* ================================================================
          Header
          ================================================================ */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Shield size={28} style={{ color: 'var(--cvs-accent-cyan)' }} />
          <div>
            <h1 style={{ fontSize: '1.1rem', fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.02em' }}>
              CVS Edge AI
            </h1>
            <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)', letterSpacing: '0.05em' }}>
              COMMERCIAL VEHICLE SAFETY
            </p>
          </div>
        </div>
        <div className={`sensor-badge ${getSensorModeBadgeClass(sensorState.sensorMode)}`}>
          <span className="dot" />
          {getSensorModeLabel(sensorState.sensorMode)}
        </div>
      </header>

      {/* ================================================================
          Pre-Start Screen
          ================================================================ */}
      {!isStarted && (
        <div className="glass-card animate-fade-in-up" style={{ padding: '32px 24px', textAlign: 'center', marginBottom: '16px' }}>
          <div style={{
            width: '80px', height: '80px', borderRadius: '50%', margin: '0 auto 20px',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.2), rgba(34,211,238,0.2))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid rgba(59,130,246,0.3)',
          }}>
            <Satellite size={36} style={{ color: 'var(--cvs-accent-cyan)' }} />
          </div>

          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '8px' }}>
            Start Shift & Calibrate Sensors
          </h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--cvs-text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
            Mount your phone on the dashboard holder, then tap below to request GPS & gyroscope permissions and begin the safety monitoring session.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button id="btn-start-shift" className="btn btn-primary" onClick={handleStartShift} style={{ width: '100%', padding: '14px', fontSize: '0.95rem' }}>
              <Satellite size={18} />
              Start with Live Phone Sensors
            </button>
            <button id="btn-start-sim" className="btn btn-ghost" onClick={handleToggleSimulation} style={{ width: '100%', padding: '12px' }}>
              <MonitorSmartphone size={18} />
              Simulated Mountain Drive (Demo)
            </button>
          </div>

          {gisReady && (
            <div style={{ marginTop: '16px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <p style={{ fontSize: '0.7rem', color: 'var(--cvs-safe)' }}>
                ✓ GIS Engine Ready — {gisInfo?.featureCount} curves cached ({gisInfo?.source})
              </p>
            </div>
          )}
        </div>
      )}

      {/* ================================================================
          Active HUD
          ================================================================ */}
      {isStarted && (
        <>
          {/* Speed Gauge + Safe Speed */}
          <div className="glass-card animate-fade-in-up" style={{
            padding: '20px', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-around',
          }}>
            {/* Current Speed */}
            <div style={{ textAlign: 'center' }}>
              <div className="speed-gauge" style={{
                background: `conic-gradient(from 135deg, ${speedColor}33 0deg, ${speedColor} ${Math.min(speed / 80 * 270, 270)}deg, var(--cvs-bg-elevated) ${Math.min(speed / 80 * 270, 270)}deg)`,
                boxShadow: riskLevel === 'CRITICAL' ? 'var(--shadow-glow-red)' : riskLevel === 'ADVISORY' ? 'var(--shadow-glow-amber)' : 'none',
              }}>
                <div className="speed-gauge-inner">
                  <span className="speed-value" style={{ color: speedColor }}>{speed}</span>
                  <span className="speed-unit">km/h</span>
                </div>
              </div>
              <p style={{ fontSize: '0.7rem', color: 'var(--cvs-text-muted)', marginTop: '6px' }}>ACTUAL SPEED</p>
            </div>

            {/* Safe Speed */}
            <div style={{ textAlign: 'center' }}>
              <div style={{
                width: '90px', height: '90px', borderRadius: '50%', display: 'flex',
                flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                background: `rgba(${riskLevel === 'CRITICAL' ? '239,68,68' : riskLevel === 'ADVISORY' ? '245,158,11' : '16,185,129'}, 0.1)`,
                border: `2px solid ${riskColor}`,
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.8rem', fontWeight: 800, color: riskColor }}>
                  {safeSpeed != null ? Math.round(safeSpeed) : '—'}
                </span>
                <span style={{ fontSize: '0.55rem', color: 'var(--cvs-text-muted)' }}>SAFE km/h</span>
              </div>

              {gisResult?.distanceToCurve != null && (
                <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-secondary)', marginTop: '8px' }}>
                  <MapPin size={11} style={{ verticalAlign: 'middle' }} /> Curve in {Math.round(gisResult.distanceToCurve)}m
                </p>
              )}
            </div>
          </div>

          {/* Risk Banner */}
          {gisResult && riskLevel !== 'SAFE' && (
            <div className={`glass-card-sm ${riskLevel === 'CRITICAL' ? 'animate-pulse-red' : 'animate-pulse-amber'}`} style={{
              padding: '12px 16px', marginBottom: '12px',
              borderColor: riskColor,
              display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <AlertTriangle size={20} style={{ color: riskColor, flexShrink: 0 }} />
              <div>
                <p style={{ fontSize: '0.8rem', fontWeight: 700, color: riskColor }}>{riskLevel}</p>
                <p style={{ fontSize: '0.7rem', color: 'var(--cvs-text-secondary)' }}>{gisResult.message}</p>
              </div>
            </div>
          )}

          {gisResult && riskLevel === 'SAFE' && gisResult.distanceToCurve == null && (
            <div className="glass-card-sm" style={{
              padding: '10px 16px', marginBottom: '12px',
              display: 'flex', alignItems: 'center', gap: '10px',
            }}>
              <CheckCircle2 size={18} style={{ color: 'var(--cvs-safe)' }} />
              <p style={{ fontSize: '0.75rem', color: 'var(--cvs-text-secondary)' }}>Clear road ahead — no curves within 300m</p>
            </div>
          )}

          {/* Curve Details Card */}
          {gisResult?.curveRadius != null && (
            <div className="glass-card-sm animate-fade-in-up" style={{ padding: '14px 16px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <Mountain size={16} style={{ color: 'var(--cvs-accent-purple)' }} />
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                  {gisResult.curveName || 'Upcoming Curve'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', fontSize: '0.7rem' }}>
                <div>
                  <p style={{ color: 'var(--cvs-text-muted)' }}>Radius</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{gisResult.curveRadius?.toFixed(1)}m</p>
                </div>
                <div>
                  <p style={{ color: 'var(--cvs-text-muted)' }}>Warn Dist</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{gisResult.warningDistance?.toFixed(0)}m</p>
                </div>
                <div>
                  <p style={{ color: 'var(--cvs-text-muted)' }}>Gradient</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{((gisResult.gradient || 0) * 100).toFixed(1)}%</p>
                </div>
              </div>
            </div>
          )}

          {/* Sensor Telemetry Panel */}
          <div className="glass-card-sm" style={{ padding: '12px 16px', marginBottom: '12px' }}>
            <button
              onClick={() => setShowTelemetry(!showTelemetry)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'none', border: 'none', color: 'var(--cvs-text-primary)', cursor: 'pointer',
                padding: 0, fontSize: '0.8rem', fontWeight: 600,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Activity size={16} style={{ color: 'var(--cvs-accent-cyan)' }} />
                Sensor Telemetry
              </span>
              <ChevronDown size={16} style={{
                transform: showTelemetry ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }} />
            </button>

            {showTelemetry && (
              <div style={{ marginTop: '12px', fontSize: '0.7rem' }}>
                {/* GPS */}
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <Satellite size={12} style={{ color: 'var(--cvs-gps-locked)' }} />
                    <span style={{ fontWeight: 600 }}>GPS</span>
                    <span style={{ color: 'var(--cvs-text-muted)', marginLeft: 'auto' }}>
                      Accuracy: {sensorState.accuracy?.toFixed(0)}m
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontFamily: 'var(--font-mono)' }}>
                    <span>Lat: {formatCoord(sensorState.lat)}</span>
                    <span>Lon: {formatCoord(sensorState.lon)}</span>
                    <span>Alt: {sensorState.altitude?.toFixed(0) || '—'}m</span>
                    <span>Hdg: {sensorState.heading?.toFixed(1)}°</span>
                  </div>
                </div>

                {/* IMU */}
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <Compass size={12} style={{ color: 'var(--cvs-accent-purple)' }} />
                    <span style={{ fontWeight: 600 }}>Gyroscope (deg/s)</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontFamily: 'var(--font-mono)' }}>
                    <span>α: {sensorState.gyroAlpha?.toFixed(1)}</span>
                    <span>β: {sensorState.gyroBeta?.toFixed(1)}</span>
                    <span>γ: {sensorState.gyroGamma?.toFixed(1)}</span>
                  </div>
                </div>

                <div style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <Zap size={12} style={{ color: 'var(--cvs-accent-amber)' }} />
                    <span style={{ fontWeight: 600 }}>Accelerometer (m/s²)</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px', fontFamily: 'var(--font-mono)' }}>
                    <span>X: {sensorState.accelX?.toFixed(2)}</span>
                    <span>Y: {sensorState.accelY?.toFixed(2)}</span>
                    <span>Z: {sensorState.accelZ?.toFixed(2)}</span>
                  </div>
                </div>

                {/* Lateral G */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0', borderTop: '1px solid var(--glass-border)' }}>
                  <span>Lateral G (gyro): </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: sensorState.harshCornering ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
                  }}>
                    {(sensorState.lateralAccel / 9.81).toFixed(2)}g
                  </span>
                  {sensorState.harshCornering && (
                    <span style={{ color: 'var(--cvs-critical)', fontWeight: 700, fontSize: '0.65rem' }}>⚠ HARSH</span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--cvs-text-muted)' }}>
                    Conf: {confidence}%
                  </span>
                </div>

                {/* Calibration */}
                <div style={{ marginTop: '8px' }}>
                  <button className="btn btn-ghost" onClick={handleCalibrate} style={{ width: '100%', padding: '8px', fontSize: '0.75rem' }}>
                    <Crosshair size={14} />
                    {sensorState.isCalibrated ? 'Re-Calibrate Mount' : 'Calibrate Phone Mount'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Simulation Controls */}
          {isSimulation && (
            <div className="glass-card-sm animate-fade-in-up" style={{ padding: '14px 16px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <MonitorSmartphone size={16} style={{ color: 'var(--cvs-simulation)' }} />
                <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>Simulation Controls</span>
              </div>

              {/* Progress bar */}
              <div style={{ marginBottom: '10px' }}>
                <div style={{
                  height: '4px', borderRadius: '2px', background: 'var(--cvs-bg-elevated)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: '2px',
                    background: 'linear-gradient(90deg, var(--cvs-accent-blue), var(--cvs-accent-cyan))',
                    width: simProgress.total > 0 ? `${(simProgress.index / simProgress.total) * 100}%` : '0%',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)', marginTop: '4px' }}>
                  Waypoint {simProgress.index} / {simProgress.total} — {simProgress.label}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-ghost" onClick={handleSimPause} style={{ flex: 1, padding: '8px' }}>
                  {simPaused ? <Play size={14} /> : <Pause size={14} />}
                  {simPaused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn btn-ghost" onClick={handleSimRestart} style={{ flex: 1, padding: '8px' }}>
                  <RotateCcw size={14} /> Restart
                </button>
              </div>
            </div>
          )}

          {/* Mode Toggle + Stop */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button
              className={`btn ${isSimulation ? 'btn-primary' : 'btn-ghost'}`}
              onClick={handleToggleSimulation}
              style={{ flex: 1, padding: '10px', fontSize: '0.75rem' }}
            >
              {isSimulation ? <Smartphone size={14} /> : <MonitorSmartphone size={14} />}
              {isSimulation ? 'Switch to Live' : 'Switch to Sim'}
            </button>
            <button className="btn btn-danger" onClick={handleStop} style={{ padding: '10px 16px' }}>
              <Square size={14} /> Stop
            </button>
          </div>
        </>
      )}

      {/* ================================================================
          Event Log
          ================================================================ */}
      <div className="glass-card-sm" style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <Timer size={14} style={{ color: 'var(--cvs-accent-cyan)' }} />
          <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Event Log</span>
          <span style={{ fontSize: '0.6rem', color: 'var(--cvs-text-muted)', marginLeft: 'auto' }}>{logs.length} entries</span>
        </div>
        <div style={{
          maxHeight: '150px', overflowY: 'auto', fontSize: '0.65rem',
          fontFamily: 'var(--font-mono)', lineHeight: 1.6,
        }}>
          {logs.length === 0 && (
            <p style={{ color: 'var(--cvs-text-muted)', fontStyle: 'italic' }}>Awaiting sensor initialisation…</p>
          )}
          {logs.map((log, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px' }}>
              <span style={{ color: 'var(--cvs-text-muted)', flexShrink: 0 }}>{log.time}</span>
              <span style={{
                color: log.level === 'error' ? 'var(--cvs-critical)'
                  : log.level === 'warning' ? 'var(--cvs-advisory)'
                  : log.level === 'success' ? 'var(--cvs-safe)'
                  : 'var(--cvs-text-secondary)',
              }}>
                {log.msg}
              </span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* Footer */}
      <footer style={{ textAlign: 'center', padding: '16px 0 8px', fontSize: '0.6rem', color: 'var(--cvs-text-muted)' }}>
        CVS Edge AI v1.0 — Mobile Sensor Fusion & Offline GIS Engine
      </footer>
    </div>
  );
}
