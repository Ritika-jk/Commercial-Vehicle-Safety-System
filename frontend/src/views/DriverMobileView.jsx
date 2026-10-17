import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Satellite,
  Compass,
  Activity,
  AlertOctagon,
  Volume2,
  VolumeX,
  Crosshair,
  Shield,
  Play,
  Pause,
  RotateCcw,
  Wifi,
  WifiOff,
  Camera,
  RefreshCw,
  Database,
  MapPin,
  Eye,
  EyeOff,
  Smartphone,
  Users,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Zap,
  Radio,
  Sliders,
  Check,
} from 'lucide-react';

import sensorEngine, { SensorMode } from '../services/sensors/sensorFusion';
import gisEngine from '../services/engine/offlineGisEngine';
import visionEngine from '../services/vision/visionEngine';
import arbitrationEngine from '../services/engine/arbitrationEngine';
import alertActuator from '../services/engine/alertActuator';
import blackboxStorage from '../services/storage/blackboxStorage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSpeed(kmh) {
  return kmh != null && Number.isFinite(kmh) ? Math.round(kmh) : 0;
}

function formatCoord(val, decimals = 5) {
  return val != null && Number.isFinite(val) ? val.toFixed(decimals) : '—';
}

function getSensorModeLabel(mode) {
  switch (mode) {
    case SensorMode.GPS_LOCKED:
      return 'GPS Locked';
    case SensorMode.IMU_DEAD_RECKONING:
      return 'IMU Dead-Reckoning';
    case SensorMode.SIMULATION:
      return 'NH44 Simulation';
    case SensorMode.OFFLINE:
      return 'Sensors Offline';
    default:
      return mode || 'Standby';
  }
}

function getSensorModeBadgeClass(mode) {
  switch (mode) {
    case SensorMode.GPS_LOCKED:
      return 'sensor-badge--gps';
    case SensorMode.IMU_DEAD_RECKONING:
      return 'sensor-badge--dr';
    case SensorMode.SIMULATION:
      return 'sensor-badge--sim';
    default:
      return 'sensor-badge--offline';
  }
}

export default function DriverMobileView({
  selectedVehicle = 'JK02-1234',
  onVehicleChange,
}) {
  // Sensor & Telemetry State
  const [sensorState, setSensorState] = useState(sensorEngine.getState());
  const [gisResult, setGisResult] = useState(null);
  const [gisReady, setGisReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [simProgress, setSimProgress] = useState({ index: 0, total: 0, label: '' });
  const [simPaused, setSimPaused] = useState(false);

  // DR countdown in seconds
  const [drCountdown, setDrCountdown] = useState(null);

  // Vision Pipeline State
  const [visionMetrics, setVisionMetrics] = useState(visionEngine.getMetrics());
  const [activeVisionScenario, setActiveVisionScenario] = useState('NORMAL');
  const [cameraFacing, setCameraFacing] = useState('user'); // 'user' or 'environment'
  const [cameraActive, setCameraActive] = useState(false);

  // Alerts & Actuator
  const [activeAlert, setActiveAlert] = useState(null);
  const [soundMuted, setSoundMuted] = useState(false);

  // Network & Outbox Blackbox State
  const [forceOffline, setForceOffline] = useState(blackboxStorage.getForceOffline());
  const [blackboxStats, setBlackboxStats] = useState({
    totalRecords: 0,
    unsyncedCount: 0,
    currentSeqNo: 0,
    lastRecordHash: 'GENESIS_0000000000000000',
    lastSyncTimestamp: null,
  });
  const [recentRecords, setRecentRecords] = useState([]);
  const [isSyncingOutbox, setIsSyncingOutbox] = useState(false);
  const [showOutboxDrawer, setShowOutboxDrawer] = useState(false);
  const [showImuDetails, setShowImuDetails] = useState(false);
  const [personalSafetyScore, setPersonalSafetyScore] = useState(92.5);

  // Vehicle & Driver info
  const [vehicleReg, setVehicleReg] = useState(selectedVehicle || 'JK02-1234');
  const [driverName, setDriverName] = useState('Ramesh Kumar');

  // Video preview element
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const gisIntervalRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);

  // Refresh stats
  const refreshStats = useCallback(async () => {
    try {
      const stats = await blackboxStorage.getStats();
      setBlackboxStats(stats);
      const all = await blackboxStorage.getAllViolations();
      if (all && Array.isArray(all)) {
        setRecentRecords(all.slice(-5).reverse());
      }
    } catch (e) {
      // IndexedDB warming up
    }
  }, []);

  // Sync vehicle change
  useEffect(() => {
    if (selectedVehicle && selectedVehicle !== vehicleReg) {
      setVehicleReg(selectedVehicle);
    }
  }, [selectedVehicle, vehicleReg]);

  // Update backend vehicle configuration
  useEffect(() => {
    let dName = 'Ramesh Kumar';
    let dId = 1;
    let vId = 1;
    if (vehicleReg === 'JK01-5678') {
      dName = 'Tariq Ahmed';
      dId = 2;
      vId = 2;
      setPersonalSafetyScore(84.0);
    } else if (vehicleReg === 'JK14-9988') {
      dName = 'Sunita Devi';
      dId = 3;
      vId = 3;
      setPersonalSafetyScore(98.0);
    } else {
      setPersonalSafetyScore(92.5);
    }
    setDriverName(dName);

    arbitrationEngine.metadata = {
      vehicleRegistration: vehicleReg,
      vehicleId: vId,
      driverId: dId,
    };
    blackboxStorage.setConfig({
      vehicleRegistration: vehicleReg,
      vehicleId: vId,
      driverId: dId,
    });
  }, [vehicleReg]);

  // Initialize GIS and Blackbox DB on mount
  useEffect(() => {
    gisEngine.initialize('jk_nh44').then(() => {
      setGisReady(true);
    }).catch((err) => {
      console.warn('[DriverMobileView] GIS init error:', err);
    });

    blackboxStorage.initDb().then(() => {
      refreshStats();
    });

    // Alert actuation listeners
    const unsubAlert = alertActuator.on('alertTriggered', (a) => setActiveAlert(a));
    const unsubDismiss = alertActuator.on('alertDismissed', () => setActiveAlert(null));

    // Violation confirmed
    const unsubConfirmed = arbitrationEngine.on('confirmedViolation', async (record) => {
      alertActuator.playAlert(record);
      const snapshot = visionEngine.generateEvidenceSnapshot(record.violation_type, record.payload_details);
      try {
        await blackboxStorage.recordViolation({
          ...record,
          vehicle_registration: vehicleReg,
          evidence_clip_ref: snapshot,
        });
        refreshStats();
      } catch (err) {
        console.error('[DriverMobileView] Blackbox write error:', err);
      }
    });

    const unsubEscalated = arbitrationEngine.on('escalatedViolation', ({ violationRecord }) => {
      alertActuator.playAlert(violationRecord);
    });

    // Sync events
    const unsubSync = blackboxStorage.on('syncSuccess', () => refreshStats());

    return () => {
      unsubAlert();
      unsubDismiss();
      unsubConfirmed();
      unsubEscalated();
      unsubSync();
    };
  }, [refreshStats, vehicleReg]);

  // Sensor state subscription
  useEffect(() => {
    const unsubState = sensorEngine.on('stateUpdate', (state) => {
      setSensorState(state);
      arbitrationEngine.updateSensorState(state);
      visionEngine.setContext({
        currentLat: state.lat || 33.08415,
        currentLon: state.lon || 75.32612,
        currentSpeed: state.speedKmh || 0,
      });

      // Update DR grace countdown if in IMU dead-reckoning
      if (state.sensorMode === SensorMode.IMU_DEAD_RECKONING && state.drDeadlineMs > 0) {
        const remaining = Math.max(0, Math.ceil((state.drDeadlineMs - Date.now()) / 1000));
        setDrCountdown(remaining);
      } else {
        setDrCountdown(null);
      }
    });

    const unsubHarsh = sensorEngine.on('harshCornering', (ev) => {
      arbitrationEngine.ingestHarshCornering(ev);
    });

    return () => {
      unsubState();
      unsubHarsh();
    };
  }, []);

  // Vision engine listener
  useEffect(() => {
    const unsubVisionCand = visionEngine.on('candidateViolation', (cand) => {
      arbitrationEngine.ingestVisionCandidate(cand);
    });
    const unsubMetrics = visionEngine.on('metricsUpdate', (m) => {
      setVisionMetrics(m);
    });
    return () => {
      unsubVisionCand();
      unsubMetrics();
    };
  }, []);

  // GIS evaluation loop (4 Hz when active)
  useEffect(() => {
    if (isStarted && gisReady) {
      gisIntervalRef.current = setInterval(() => {
        const s = sensorEngine.getState();
        if (s.lat !== 0 && s.lon !== 0) {
          const res = gisEngine.evaluateUpcomingRoad(
            s.lat,
            s.lon,
            s.speedKmh,
            s.heading,
            s.sensorMode,
          );
          setGisResult(res);
          arbitrationEngine.ingestGisEvaluation(res);
        }
      }, 250);
    }
    return () => {
      if (gisIntervalRef.current) clearInterval(gisIntervalRef.current);
    };
  }, [isStarted, gisReady]);

  // Telemetry Heartbeat Sender (Every 2 seconds to /api/telemetry/heartbeat)
  useEffect(() => {
    if (isStarted && !forceOffline) {
      heartbeatIntervalRef.current = setInterval(async () => {
        const s = sensorEngine.getState();
        const v = visionEngine.getMetrics();
        if (s.lat !== 0 && s.lon !== 0) {
          try {
            await fetch('/api/telemetry/heartbeat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                vehicle_registration: vehicleReg,
                lat: s.lat,
                lon: s.lon,
                speed: s.speedKmh || 0,
                heading: s.heading || 0,
                sensor_mode: s.sensorMode || 'GPS_LOCKED',
                driver_id: vehicleReg === 'JK02-1234' ? 1 : vehicleReg === 'JK01-5678' ? 2 : 3,
                cabin_occupancy: v.cabinOccupancy || 18,
                active_advisory: activeAlert ? activeAlert.type : null,
              }),
            });
          } catch (e) {
            // Server offline or network deferred
          }
        }
      }, 2000);
    }
    return () => {
      if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
    };
  }, [isStarted, forceOffline, vehicleReg, activeAlert]);

  // Video element binding for live camera preview
  useEffect(() => {
    if (cameraActive && videoRef.current) {
      const activeVideo = visionEngine.getActiveVideoElement();
      if (activeVideo && activeVideo.srcObject) {
        videoRef.current.srcObject = activeVideo.srcObject;
        videoRef.current.play().catch(() => {});
      }
    }
  }, [cameraActive, cameraFacing]);

  // ---------------------------------------------------------------------------
  // User Actions
  // ---------------------------------------------------------------------------

  const handleStartShift = async (useSim = false) => {
    alertActuator.unlockAudio();
    arbitrationEngine.startEvaluationLoop();

    if (useSim) {
      setIsSimulation(true);
      sensorEngine.setSimulationMode(true);
      visionEngine.setSimulationMode(true);
      const sim = sensorEngine.getSimulator();
      if (sim) {
        sim.on('waypoint', ({ index, total, waypoint }) => {
          setSimProgress({ index, total, label: waypoint.label });
        });
      }
    } else {
      setIsSimulation(false);
      sensorEngine.setSimulationMode(false);
      await sensorEngine.requestPermissionsAndStart();
      const res = await visionEngine.startCameras({
        front: cameraFacing === 'user',
        rear: cameraFacing === 'environment',
      });
      setCameraActive(res.front || res.rear);
    }

    setIsStarted(true);
  };

  const handleEndShift = () => {
    sensorEngine.stop();
    visionEngine.stopCameras();
    arbitrationEngine.stopEvaluationLoop();
    alertActuator.dismissActiveAlert();
    setIsStarted(false);
    setIsSimulation(false);
    setCameraActive(false);
    setGisResult(null);
  };

  const handleToggleOfflineMode = () => {
    const nextMode = !forceOffline;
    setForceOffline(nextMode);
    blackboxStorage.setForceOffline(nextMode);
  };

  const handleCalibrateMount = () => {
    sensorEngine.calibrateMount();
  };

  const handleTriggerSos = () => {
    alertActuator.unlockAudio();
    arbitrationEngine.triggerSos('DRIVER');
  };

  const handleToggleSound = () => {
    const next = !soundMuted;
    setSoundMuted(next);
    alertActuator.updateSettings({ soundEnabled: !next, voiceEnabled: !next });
  };

  const handleSyncOutboxNow = async () => {
    setIsSyncingOutbox(true);
    await blackboxStorage.syncNow();
    await refreshStats();
    setIsSyncingOutbox(false);
  };

  // Switch camera between front and rear
  const handleSwitchCameraFacing = async () => {
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
    setCameraFacing(nextFacing);
    if (!isSimulation && isStarted) {
      await visionEngine.stopCameras();
      const res = await visionEngine.startCameras({
        front: nextFacing === 'user',
        rear: nextFacing === 'environment',
      });
      setCameraActive(res.front || res.rear);
    }
  };

  // Demo injection triggers
  const handleInjectDemo = (infractionType) => {
    alertActuator.unlockAudio();
    if (!isStarted) {
      handleStartShift(true);
    }

    switch (infractionType) {
      case 'OVERSPEED': {
        const sim = sensorEngine.getSimulator();
        if (sim) {
          // Waypoint 5 is the Patnitop Hairpin entry (R=31.8m, safe=27km/h)
          sim.jumpTo(5);
        }
        sensorEngine._state.speedKmh = 56;
        sensorEngine._state.lat = 33.0838;
        sensorEngine._state.lon = 75.3255;
        sensorEngine._emit('stateUpdate', sensorEngine.getState());
        break;
      }
      case 'TUNNEL_DROPOUT': {
        const sim = sensorEngine.getSimulator();
        if (sim) {
          // Waypoint 11 is Chenani Tunnel Entry (GPS drop)
          sim.jumpTo(11);
        } else {
          sensorEngine.setTunnelDeadReckoningMode(true);
        }
        break;
      }
      case 'DROWSINESS':
        setActiveVisionScenario('DROWSINESS');
        visionEngine.simulateScenario('DROWSINESS');
        break;
      case 'PHONE_USE':
        setActiveVisionScenario('PHONE_USE');
        visionEngine.simulateScenario('PHONE_USE');
        break;
      case 'OVERCROWDING':
        setActiveVisionScenario('OVERCROWDING');
        visionEngine.simulateScenario('OVERCROWDING');
        break;
      case 'RESET_NORMAL':
        setActiveVisionScenario('NORMAL');
        visionEngine.simulateScenario('NORMAL');
        if (sensorEngine.getSimulator()) {
          sensorEngine.getSimulator().jumpTo(0);
        }
        break;
      default:
        break;
    }
  };

  // Calculated Speed & Curve Metrics
  const speed = formatSpeed(sensorState.speedKmh);
  const safeSpeed = gisResult?.safeSpeedKmh != null ? Math.round(gisResult.safeSpeedKmh) : null;
  const curveRadius = gisResult?.curveRadius != null ? Math.round(gisResult.curveRadius) : null;
  const distanceToCurve = gisResult?.distanceToCurve != null ? Math.round(gisResult.distanceToCurve) : null;
  const warningDistance = gisResult?.warningDistance != null ? Math.round(gisResult.warningDistance) : 150;
  const riskLevel = gisResult?.riskLevel || 'SAFE';

  // HUD Dynamic Colors
  const isCritical = activeAlert?.severity === 'CRITICAL' || riskLevel === 'CRITICAL';
  const isAdvisory = activeAlert?.severity === 'ADVISORY' || riskLevel === 'ADVISORY';

  const hudBorderColor = isCritical
    ? 'var(--cvs-critical)'
    : isAdvisory
    ? 'var(--cvs-advisory)'
    : 'var(--glass-border)';

  const hudGlowClass = isCritical
    ? 'animate-pulse-red'
    : isAdvisory
    ? 'animate-pulse-amber'
    : '';

  const actualSpeedColor =
    safeSpeed != null && speed > safeSpeed + 15
      ? 'var(--cvs-critical)'
      : safeSpeed != null && speed > safeSpeed + 5
      ? 'var(--cvs-advisory)'
      : 'var(--cvs-safe)';

  return (
    <div
      className={`driver-hud-container ${hudGlowClass}`}
      style={{
        minHeight: '100%',
        padding: '12px',
        maxWidth: '520px',
        margin: '0 auto',
        border: `2px solid ${hudBorderColor}`,
        borderRadius: '24px',
        background: 'radial-gradient(ellipse at top, #131b2e 0%, #0a0e1a 100%)',
        transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
      }}
    >
      {/* ====================================================================
          1. Shift Header & Hardware Status Bar (SRS 10.1)
          ==================================================================== */}
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          marginBottom: '12px',
          paddingBottom: '10px',
          borderBottom: '1px solid var(--glass-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'rgba(59, 130, 246, 0.2)',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Shield size={20} style={{ color: 'var(--cvs-accent-cyan)' }} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <select
                  value={vehicleReg}
                  onChange={(e) => {
                    setVehicleReg(e.target.value);
                    if (onVehicleChange) onVehicleChange(e.target.value);
                  }}
                  style={{
                    background: 'var(--cvs-bg-elevated)',
                    color: 'var(--cvs-text-primary)',
                    border: '1px solid var(--glass-border)',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    padding: '2px 6px',
                    cursor: 'pointer',
                  }}
                >
                  <option value="JK02-1234">JK02-1234 (Jammu)</option>
                  <option value="JK01-5678">JK01-5678 (Srinagar)</option>
                  <option value="JK14-9988">JK14-9988 (Udhampur)</option>
                </select>
                <span
                  style={{
                    fontSize: '0.65rem',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    background: 'rgba(34, 211, 238, 0.15)',
                    color: 'var(--cvs-accent-cyan)',
                    fontWeight: 600,
                  }}
                >
                  Score: {personalSafetyScore.toFixed(0)}
                </span>
              </div>
              <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-secondary)', marginTop: '2px' }}>
                Driver: <strong style={{ color: 'var(--cvs-text-primary)' }}>{driverName}</strong>
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Audio warning mute */}
            <button
              onClick={handleToggleSound}
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--glass-border)',
                borderRadius: '8px',
                padding: '6px',
                color: soundMuted ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
                cursor: 'pointer',
              }}
              title={soundMuted ? 'Unmute Audio Warning System' : 'Mute Voice Warnings'}
            >
              {soundMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>

            {/* Network Mode Toggle (Online vs Force Offline) */}
            <button
              onClick={handleToggleOfflineMode}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 8px',
                borderRadius: '8px',
                fontSize: '0.68rem',
                fontWeight: 700,
                border: forceOffline
                  ? '1px solid var(--cvs-advisory)'
                  : '1px solid rgba(16, 185, 129, 0.4)',
                background: forceOffline
                  ? 'rgba(245, 158, 11, 0.2)'
                  : 'rgba(16, 185, 129, 0.15)',
                color: forceOffline ? 'var(--cvs-advisory)' : 'var(--cvs-safe)',
                cursor: 'pointer',
              }}
              title="Toggle network connectivity to test Outbox queueing"
            >
              {forceOffline ? <WifiOff size={13} /> : <Wifi size={13} />}
              {forceOffline ? 'Offline Mode' : 'Online'}
            </button>
          </div>
        </div>

        {/* Live Hardware Status Pills */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
          {/* Sensor Mode Pill with DR grace countdown */}
          <div className={`sensor-badge ${getSensorModeBadgeClass(sensorState.sensorMode)}`} style={{ flex: 1, justifyContent: 'center' }}>
            <span className="dot" />
            <span>{getSensorModeLabel(sensorState.sensorMode)}</span>
            {drCountdown != null && (
              <span
                style={{
                  marginLeft: '4px',
                  background: 'rgba(0,0,0,0.3)',
                  padding: '1px 5px',
                  borderRadius: '10px',
                  fontSize: '0.65rem',
                  fontFamily: 'var(--font-mono)',
                  color: 'white',
                }}
              >
                {drCountdown}s grace
              </span>
            )}
          </div>

          {/* Camera FPS indicator */}
          <div
            style={{
              padding: '3px 8px',
              borderRadius: '100px',
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--glass-border)',
              fontSize: '0.68rem',
              color: 'var(--cvs-text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <Camera size={11} style={{ color: 'var(--cvs-accent-cyan)' }} />
            <span>{visionMetrics.fps || 30} FPS</span>
          </div>

          {/* Shift Control Button */}
          {isStarted ? (
            <button
              onClick={handleEndShift}
              className="btn btn-ghost"
              style={{ padding: '4px 10px', fontSize: '0.7rem', color: 'var(--cvs-critical)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
            >
              End Shift
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                onClick={() => handleStartShift(false)}
                className="btn btn-primary"
                style={{ padding: '4px 8px', fontSize: '0.68rem' }}
              >
                Start Live
              </button>
              <button
                onClick={() => handleStartShift(true)}
                className="btn btn-ghost"
                style={{ padding: '4px 8px', fontSize: '0.68rem' }}
              >
                Simulate
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ====================================================================
          Active Alert Banner (Advisory / Critical)
          ==================================================================== */}
      {activeAlert && (
        <div
          className={`glass-card ${activeAlert.severity === 'CRITICAL' ? 'animate-pulse-red' : 'animate-pulse-amber'}`}
          style={{
            padding: '10px 14px',
            marginBottom: '10px',
            borderColor: activeAlert.severity === 'CRITICAL' ? 'var(--cvs-critical)' : 'var(--cvs-advisory)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            background: activeAlert.severity === 'CRITICAL' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.15)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertOctagon
              size={22}
              style={{
                color: activeAlert.severity === 'CRITICAL' ? 'var(--cvs-critical)' : 'var(--cvs-advisory)',
                flexShrink: 0,
              }}
            />
            <div>
              <span
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 800,
                  color: activeAlert.severity === 'CRITICAL' ? 'var(--cvs-critical)' : 'var(--cvs-advisory)',
                }}
              >
                {activeAlert.severity}: {activeAlert.type.replace('_', ' ')}
              </span>
              <p style={{ fontSize: '0.68rem', color: 'var(--cvs-text-primary)', marginTop: '2px' }}>
                {activeAlert.type === 'OVERSPEED_CURVE'
                  ? `Speed ${formatSpeed(activeAlert.record.speed_actual)} km/h exceeds safe curve limit ${formatSpeed(activeAlert.record.speed_safe)} km/h`
                  : activeAlert.type === 'DROWSINESS'
                  ? 'Eye aspect ratio < 0.21! Pull over safely immediately.'
                  : activeAlert.type === 'DISTRACTION'
                  ? 'Eyes off road! Maintain forward driving attention.'
                  : activeAlert.type === 'PHONE_USE'
                  ? 'Mobile phone use detected near steering wheel!'
                  : activeAlert.type === 'OVERCROWDING'
                  ? 'Cabin occupancy exceeds legal permitted capacity!'
                  : 'Emergency alert registered.'}
              </p>
            </div>
          </div>
          <button
            onClick={() => alertActuator.dismissActiveAlert()}
            className="btn btn-ghost"
            style={{ padding: '4px 8px', fontSize: '0.65rem' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ====================================================================
          2. Primary Speed & Curve Anticipation HUD (High-Contrast Circular HUD)
          ==================================================================== */}
      <div
        className="glass-card"
        style={{
          padding: '16px',
          marginBottom: '10px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-around', width: '100%', gap: '12px' }}>
          {/* Actual Speedometer */}
          <div style={{ textAlign: 'center' }}>
            <div
              className="speed-gauge"
              style={{
                width: '136px',
                height: '136px',
                background: `conic-gradient(from 135deg, ${actualSpeedColor}33 0deg, ${actualSpeedColor} ${Math.min((speed / 80) * 270, 270)}deg, var(--cvs-bg-elevated) ${Math.min((speed / 80) * 270, 270)}deg)`,
              }}
            >
              <div className="speed-gauge-inner" style={{ width: '110px', height: '110px' }}>
                <span className="speed-value" style={{ color: actualSpeedColor, fontSize: '2.4rem' }}>
                  {speed}
                </span>
                <span className="speed-unit">KM/H</span>
              </div>
            </div>
            <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)', marginTop: '4px', fontWeight: 600 }}>
              ACTUAL SPEED
            </p>
          </div>

          {/* Recommended Safe Curve Speed ($v_safe$) & Radius */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '94px',
                height: '94px',
                borderRadius: '50%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: isCritical
                  ? 'rgba(239, 68, 68, 0.15)'
                  : isAdvisory
                  ? 'rgba(245, 158, 11, 0.15)'
                  : 'rgba(16, 185, 129, 0.15)',
                border: `2.5px solid ${isCritical ? 'var(--cvs-critical)' : isAdvisory ? 'var(--cvs-advisory)' : 'var(--cvs-safe)'}`,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '1.9rem',
                  fontWeight: 800,
                  color: isCritical ? 'var(--cvs-critical)' : isAdvisory ? 'var(--cvs-advisory)' : 'var(--cvs-safe)',
                  lineHeight: 1,
                }}
              >
                {safeSpeed != null ? safeSpeed : '—'}
              </span>
              <span style={{ fontSize: '0.55rem', color: 'var(--cvs-text-muted)', fontWeight: 700, marginTop: '2px' }}>
                SAFE KM/H
              </span>
            </div>

            {/* Upcoming Curve Radius */}
            <div
              style={{
                textAlign: 'center',
                padding: '4px 10px',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--glass-border)',
                minWidth: '100px',
              }}
            >
              <p style={{ fontSize: '0.6rem', color: 'var(--cvs-text-muted)' }}>CURVE RADIUS</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', fontWeight: 700, color: 'var(--cvs-accent-cyan)' }}>
                {curveRadius != null ? `${curveRadius}m` : 'Straight'}
              </p>
            </div>
          </div>
        </div>

        {/* Distance Countdown Bar */}
        {distanceToCurve != null && (
          <div style={{ width: '100%', marginTop: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', marginBottom: '4px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--cvs-text-secondary)' }}>
                <MapPin size={12} style={{ color: 'var(--cvs-accent-cyan)' }} />
                <span>Upcoming: {gisResult?.curveName || 'Hill Curve Ahead'}</span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--cvs-accent-amber)' }}>
                {distanceToCurve}m
              </span>
            </div>
            <div
              style={{
                width: '100%',
                height: '6px',
                background: 'var(--cvs-bg-elevated)',
                borderRadius: '3px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: isCritical
                    ? 'var(--cvs-critical)'
                    : isAdvisory
                    ? 'var(--cvs-advisory)'
                    : 'var(--cvs-safe)',
                  width: `${Math.max(5, Math.min(100, (1 - distanceToCurve / Math.max(warningDistance, 250)) * 100))}%`,
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ====================================================================
          3. One-Click Demo Infraction & Scenario Buttons (SRS 10.1)
          ==================================================================== */}
      <div
        className="glass-card-sm"
        style={{
          padding: '10px 12px',
          marginBottom: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Zap size={13} style={{ color: 'var(--cvs-accent-amber)' }} />
            One-Click Infraction Injectors (Demo Testing)
          </span>
          <button
            onClick={() => handleInjectDemo('RESET_NORMAL')}
            className="btn btn-ghost"
            style={{ padding: '2px 6px', fontSize: '0.62rem' }}
          >
            Reset
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
          <button
            onClick={() => handleInjectDemo('OVERSPEED')}
            className="btn btn-ghost"
            style={{ padding: '6px 4px', fontSize: '0.65rem', borderColor: 'rgba(239, 68, 68, 0.3)' }}
          >
            Curve Overspeed
          </button>
          <button
            onClick={() => handleInjectDemo('TUNNEL_DROPOUT')}
            className="btn btn-ghost"
            style={{ padding: '6px 4px', fontSize: '0.65rem', borderColor: 'rgba(139, 92, 246, 0.4)' }}
          >
            GPS Tunnel (DR)
          </button>
          <button
            onClick={() => handleInjectDemo('DROWSINESS')}
            className="btn btn-ghost"
            style={{
              padding: '6px 4px',
              fontSize: '0.65rem',
              borderColor: activeVisionScenario === 'DROWSINESS' ? 'var(--cvs-critical)' : 'var(--glass-border)',
            }}
          >
            Drowsiness
          </button>
          <button
            onClick={() => handleInjectDemo('PHONE_USE')}
            className="btn btn-ghost"
            style={{
              padding: '6px 4px',
              fontSize: '0.65rem',
              borderColor: activeVisionScenario === 'PHONE_USE' ? 'var(--cvs-critical)' : 'var(--glass-border)',
            }}
          >
            Phone Use
          </button>
          <button
            onClick={() => handleInjectDemo('OVERCROWDING')}
            className="btn btn-ghost"
            style={{
              padding: '6px 4px',
              fontSize: '0.65rem',
              borderColor: activeVisionScenario === 'OVERCROWDING' ? 'var(--cvs-critical)' : 'var(--glass-border)',
            }}
          >
            Overcrowding
          </button>
          <button
            onClick={() => handleInjectDemo('RESET_NORMAL')}
            className="btn btn-ghost"
            style={{ padding: '6px 4px', fontSize: '0.65rem', color: 'var(--cvs-safe)' }}
          >
            <Check size={11} /> Clear All
          </button>
        </div>
      </div>

      {/* ====================================================================
          4. Live Mobile Sensor & AI Telemetry Cards
          ==================================================================== */}
      {/* (A) Camera AI Preview (DMS + Passenger Occupancy) */}
      <div className="glass-card-sm" style={{ padding: '12px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Camera size={14} style={{ color: 'var(--cvs-accent-cyan)' }} />
            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>Edge Vision DMS & Cabin Preview</span>
          </div>
          <button
            onClick={handleSwitchCameraFacing}
            className="btn btn-ghost"
            style={{ padding: '3px 8px', fontSize: '0.62rem' }}
          >
            {cameraFacing === 'user' ? 'Front: Driver DMS' : 'Rear: Cabin'}
          </button>
        </div>

        {/* Video / Visual Preview Display */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '110px',
            borderRadius: '10px',
            overflow: 'hidden',
            background: '#070b14',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid var(--glass-border)',
            marginBottom: '8px',
          }}
        >
          {cameraActive ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--cvs-text-muted)', fontSize: '0.7rem' }}>
              <Camera size={24} style={{ margin: '0 auto 4px', opacity: 0.5 }} />
              <p>Simulated Edge Vision Stream</p>
              <span style={{ fontSize: '0.6rem' }}>In-Memory WASM Inference Active</span>
            </div>
          )}

          {/* Overlay HUD indicators */}
          <div
            style={{
              position: 'absolute',
              top: '6px',
              left: '6px',
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.6rem',
              fontFamily: 'var(--font-mono)',
              color: visionMetrics.isDrowsy ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
            }}
          >
            EAR: {visionMetrics.ear?.toFixed(2)} {visionMetrics.isDrowsy && '⚠ CLOSED'}
          </div>

          <div
            style={{
              position: 'absolute',
              top: '6px',
              right: '6px',
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.6rem',
              fontFamily: 'var(--font-mono)',
              color: visionMetrics.phoneDetected ? 'var(--cvs-critical)' : 'var(--cvs-text-secondary)',
            }}
          >
            Phone: {visionMetrics.phoneDetected ? 'DETECTED' : 'CLEAR'}
          </div>

          <div
            style={{
              position: 'absolute',
              bottom: '6px',
              left: '6px',
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.6rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Yaw: {visionMetrics.headPose?.yaw?.toFixed(0)}° | Pitch: {visionMetrics.headPose?.pitch?.toFixed(0)}°
          </div>

          <div
            style={{
              position: 'absolute',
              bottom: '6px',
              right: '6px',
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '0.6rem',
              fontFamily: 'var(--font-mono)',
              color: visionMetrics.isOvercrowded ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
            }}
          >
            Seats: {visionMetrics.cabinOccupancy} / 25
          </div>
        </div>

        {/* Vision Metric Pills */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '0.65rem' }}>
          <div
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: visionMetrics.isDrowsy ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${visionMetrics.isDrowsy ? 'var(--cvs-critical)' : 'transparent'}`,
              textAlign: 'center',
            }}
          >
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>EAR (Drowsy)</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: visionMetrics.isDrowsy ? 'var(--cvs-critical)' : 'var(--cvs-safe)' }}>
              {visionMetrics.ear?.toFixed(2)}
            </p>
          </div>

          <div
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: visionMetrics.isYawning ? 'rgba(245, 158, 11, 0.15)' : 'rgba(255, 255, 255, 0.03)',
              textAlign: 'center',
            }}
          >
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>MAR (Yawn)</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: visionMetrics.isYawning ? 'var(--cvs-advisory)' : 'var(--cvs-safe)' }}>
              {visionMetrics.mar?.toFixed(2)}
            </p>
          </div>

          <div
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: visionMetrics.isDistracted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${visionMetrics.isDistracted ? 'var(--cvs-critical)' : 'transparent'}`,
              textAlign: 'center',
            }}
          >
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>Head Pose</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: visionMetrics.isDistracted ? 'var(--cvs-critical)' : 'var(--cvs-safe)' }}>
              {Math.abs(visionMetrics.headPose?.yaw || 0) > 30 ? 'Distracted' : 'Focused'}
            </p>
          </div>

          <div
            style={{
              padding: '6px',
              borderRadius: '6px',
              background: visionMetrics.isOvercrowded ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${visionMetrics.isOvercrowded ? 'var(--cvs-critical)' : 'transparent'}`,
              textAlign: 'center',
            }}
          >
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>Cabin Count</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: visionMetrics.isOvercrowded ? 'var(--cvs-critical)' : 'var(--cvs-text-primary)' }}>
              {visionMetrics.cabinOccupancy} / 25
            </p>
          </div>
        </div>
      </div>

      {/* (B) Gyroscope & IMU Card */}
      <div className="glass-card-sm" style={{ padding: '12px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Activity size={14} style={{ color: 'var(--cvs-accent-purple)' }} />
            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>IMU & Gyroscope Telemetry</span>
          </div>
          <button
            onClick={() => setShowImuDetails(!showImuDetails)}
            style={{ background: 'none', border: 'none', color: 'var(--cvs-text-muted)', cursor: 'pointer', padding: 0 }}
          >
            {showImuDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {/* 3-Axis Gyroscope Rates (alpha, beta, gamma deg/s) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', fontFamily: 'var(--font-mono)', fontSize: '0.68rem', marginBottom: '8px' }}>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px 6px', borderRadius: '4px' }}>
            <span style={{ color: 'var(--cvs-text-muted)' }}>α (Yaw): </span>
            <span style={{ color: 'var(--cvs-text-primary)' }}>{sensorState.gyroAlpha?.toFixed(1) || '0.0'}°/s</span>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px 6px', borderRadius: '4px' }}>
            <span style={{ color: 'var(--cvs-text-muted)' }}>β (Pitch): </span>
            <span style={{ color: 'var(--cvs-text-primary)' }}>{sensorState.gyroBeta?.toFixed(1) || '0.0'}°/s</span>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '4px 6px', borderRadius: '4px' }}>
            <span style={{ color: 'var(--cvs-text-muted)' }}>γ (Roll): </span>
            <span style={{ color: 'var(--cvs-text-primary)' }}>{sensorState.gyroGamma?.toFixed(1) || '0.0'}°/s</span>
          </div>
        </div>

        {/* Lateral G-Force Bar */}
        <div style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', marginBottom: '3px' }}>
            <span style={{ color: 'var(--cvs-text-secondary)' }}>Lateral Cornering Force:</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                color: sensorState.harshCornering ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
              }}
            >
              {(sensorState.lateralAccel / 9.81).toFixed(2)}g {sensorState.harshCornering && '⚠ HARSH'}
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: '5px',
              borderRadius: '3px',
              background: 'var(--cvs-bg-elevated)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                background: sensorState.harshCornering ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
                width: `${Math.min(100, ((sensorState.lateralAccel / 9.81) / 0.65) * 100)}%`,
                transition: 'width 0.15s ease',
              }}
            />
          </div>
        </div>

        {/* Pitch / Roll Horizon & Calibrate Mount Button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.65rem', color: 'var(--cvs-text-secondary)' }}>
            <Compass size={13} style={{ color: 'var(--cvs-accent-blue)' }} />
            <span>Horizon: Pitch {sensorState.pitch?.toFixed(1)}° | Roll {sensorState.roll?.toFixed(1)}°</span>
          </div>
          <button
            onClick={handleCalibrateMount}
            className="btn btn-ghost"
            style={{ padding: '3px 8px', fontSize: '0.62rem' }}
          >
            <Crosshair size={11} /> Calibrate Mount
          </button>
        </div>

        {/* Expanded Detailed Coordinates */}
        {showImuDetails && (
          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--glass-border)', fontSize: '0.62rem', fontFamily: 'var(--font-mono)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            <span>Lat: {formatCoord(sensorState.lat)}</span>
            <span>Lon: {formatCoord(sensorState.lon)}</span>
            <span>Hdg: {sensorState.heading?.toFixed(1)}°</span>
            <span>Accuracy: {sensorState.accuracy?.toFixed(0) || '—'}m</span>
          </div>
        )}
      </div>

      {/* ====================================================================
          5. Local Blackbox & Outbox Drawer (FR-11, FR-12, Stage 5)
          ==================================================================== */}
      <div className="glass-card-sm" style={{ padding: '12px', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Database size={14} style={{ color: 'var(--cvs-accent-cyan)' }} />
            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>Local Tamper-Evident Blackbox Ledger</span>
          </div>
          <button
            onClick={() => setShowOutboxDrawer(!showOutboxDrawer)}
            style={{ background: 'none', border: 'none', color: 'var(--cvs-text-muted)', cursor: 'pointer', padding: 0 }}
          >
            {showOutboxDrawer ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '0.68rem', marginBottom: '8px' }}>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>Unsynced Outbox</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: blackboxStats.unsyncedCount > 0 ? 'var(--cvs-advisory)' : 'var(--cvs-safe)' }}>
              {blackboxStats.unsyncedCount} Queued
            </p>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>Total Chained</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>{blackboxStats.totalRecords} Blocks</p>
          </div>
          <div style={{ background: 'rgba(255, 255, 255, 0.03)', padding: '6px', borderRadius: '6px', textAlign: 'center' }}>
            <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.58rem' }}>Safety Score</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--cvs-safe)' }}>
              {personalSafetyScore.toFixed(0)}/100
            </p>
          </div>
        </div>

        {/* Last SHA-256 Hash Signature */}
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.3)',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '0.62rem',
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <span style={{ color: 'var(--cvs-text-muted)' }}>Last Record Hash:</span>
          <span style={{ color: 'var(--cvs-accent-cyan)' }}>{blackboxStats.lastRecordHash?.slice(0, 18)}…</span>
        </div>

        {/* Sync Button */}
        <button
          onClick={handleSyncOutboxNow}
          disabled={isSyncingOutbox || forceOffline}
          className="btn btn-ghost"
          style={{ width: '100%', padding: '6px', fontSize: '0.68rem', marginBottom: '8px' }}
        >
          <RefreshCw size={12} className={isSyncingOutbox ? 'animate-spin' : ''} />
          {isSyncingOutbox ? 'Flushing Outbox to Cloud…' : forceOffline ? 'Sync Disabled (Offline Mode)' : 'Flush Outbox Now'}
        </button>

        {/* Collapsible Record Inspection */}
        {showOutboxDrawer && (
          <div style={{ fontSize: '0.62rem', fontFamily: 'var(--font-mono)', borderTop: '1px solid var(--glass-border)', paddingTop: '6px' }}>
            <p style={{ color: 'var(--cvs-text-muted)', marginBottom: '4px' }}>Recent Blackbox Events:</p>
            {recentRecords.length === 0 ? (
              <p style={{ color: 'var(--cvs-text-secondary)', fontStyle: 'italic' }}>No records logged yet this shift.</p>
            ) : (
              recentRecords.map((r) => (
                <div
                  key={r.id || r.seq_no}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '3px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                  }}
                >
                  <span style={{ color: r.severity === 'CRITICAL' ? 'var(--cvs-critical)' : 'var(--cvs-advisory)' }}>
                    #{r.seq_no} {r.violation_type}
                  </span>
                  <span style={{ color: r.synced ? 'var(--cvs-safe)' : 'var(--cvs-advisory)' }}>
                    {r.synced ? '✓ Synced' : 'Queued'}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ====================================================================
          6. High-Visibility Tactile Manual SOS Button
          ==================================================================== */}
      <div style={{ marginTop: '8px' }}>
        <button
          onClick={handleTriggerSos}
          className="btn btn-danger"
          style={{
            width: '100%',
            padding: '14px',
            fontSize: '0.95rem',
            fontWeight: 800,
            letterSpacing: '0.05em',
            boxShadow: '0 4px 20px rgba(239, 68, 68, 0.4)',
          }}
        >
          <AlertOctagon size={20} />
          EMERGENCY DRIVER SOS
        </button>
      </div>

      {/* Footer info */}
      <div style={{ textAlign: 'center', marginTop: '10px', fontSize: '0.6rem', color: 'var(--cvs-text-muted)' }}>
        CVS Commercial Driver Edge Companion • SRS Section 10.1 Module
      </div>
    </div>
  );
}
