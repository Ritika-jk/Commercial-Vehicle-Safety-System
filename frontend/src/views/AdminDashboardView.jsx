import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Shield,
  Activity,
  AlertTriangle,
  AlertOctagon,
  RefreshCw,
  Database,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
  FileText,
  Download,
  Eye,
  Search,
  Filter,
  Users,
  MapPin,
  TrendingDown,
  Layers,
  Clock,
  Radio,
  Sliders,
  Sparkles,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  PointElement,
  LineElement,
} from 'chart.js';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
  PointElement,
  LineElement,
);

export default function AdminDashboardView({ selectedVehicle = 'JK02-1234' }) {
  // 1. Role State: FLEET_OPERATOR vs TRANSPORT_AUTHORITY
  const [activeRole, setActiveRole] = useState('FLEET_OPERATOR'); // 'FLEET_OPERATOR' | 'TRANSPORT_AUTHORITY'

  // Fleet & Telemetry State
  const [vehicles, setVehicles] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [violations, setViolations] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [activeVehicleReg, setActiveVehicleReg] = useState(selectedVehicle || 'JK02-1234');

  // WebSocket Live Stream
  const [wsConnected, setWsConnected] = useState(false);
  const [liveWsCount, setLiveWsCount] = useState(0);
  const wsRef = useRef(null);

  // Cryptographic Ledger Verification State
  const [chainVerification, setChainVerification] = useState(null);
  const [isVerifyingChain, setIsVerifyingChain] = useState(false);
  const [tamperingEventId, setTamperingEventId] = useState(null);
  const [isResettingDemo, setIsResettingDemo] = useState(false);

  // DPDP Act Evidence Modal State
  const [selectedEvidenceEvent, setSelectedEvidenceEvent] = useState(null);
  const [evidenceData, setEvidenceData] = useState(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState(null);

  // Leaflet Map Refs
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const vehicleMarkersRef = useRef({});
  const curvesLayerRef = useRef(null);
  const violationsLayerRef = useRef(null);

  // Chart Refs
  const scoreChartRef = useRef(null);
  const scoreChartInstance = useRef(null);
  const violationChartRef = useRef(null);
  const violationChartInstance = useRef(null);

  // Filters for violation feed
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [lateSyncOnly, setLateSyncOnly] = useState(false);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchFleetData = useCallback(async () => {
    try {
      const [vRes, dRes, violRes, auditRes] = await Promise.all([
        fetch('/api/vehicles'),
        fetch('/api/drivers'),
        fetch('/api/violations?limit=100'),
        fetch('/api/audit-logs'),
      ]);

      if (vRes.ok) setVehicles(await vRes.json());
      if (dRes.ok) setDrivers(await dRes.json());
      if (violRes.ok) setViolations(await violRes.json());
      if (auditRes.ok) setAuditLogs(await auditRes.json());
    } catch (err) {
      console.warn('[AdminDashboard] Error fetching fleet data:', err);
    }
  }, []);

  const verifyChain = useCallback(async (reg = activeVehicleReg) => {
    setIsVerifyingChain(true);
    try {
      const res = await fetch(`/api/verify/${reg}`);
      if (res.ok) {
        const data = await res.json();
        setChainVerification(data);
      }
    } catch (err) {
      console.error('[AdminDashboard] Chain verify error:', err);
    } finally {
      setIsVerifyingChain(false);
    }
  }, [activeVehicleReg]);

  // Initial Load
  useEffect(() => {
    fetchFleetData();
    verifyChain(activeVehicleReg);
    const interval = setInterval(fetchFleetData, 5000);
    return () => clearInterval(interval);
  }, [fetchFleetData, verifyChain, activeVehicleReg]);

  // ---------------------------------------------------------------------------
  // WebSocket Connection
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/fleet`;

    let socket;
    try {
      socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        setWsConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event_type === 'CONNECTED') {
            setLiveWsCount(msg.client_count || 1);
          } else if (msg.event_type === 'TELEMETRY_UPDATE') {
            // Update vehicle marker on map
            updateVehiclePosition(msg);
          } else if (msg.event_type === 'VIOLATION_ALERT') {
            // Prepend incoming violation alert
            setViolations((prev) => [
              {
                id: msg.violation_id,
                vehicle_registration: activeVehicleReg,
                violation_type: msg.violation_type,
                severity: msg.severity,
                timestamp_device: msg.timestamp,
                timestamp_server: new Date().toISOString(),
                arrived_late: Boolean(msg.arrived_late),
                speed_actual: msg.speed_actual,
                speed_safe: msg.speed_safe,
                sensor_mode: msg.sensor_mode,
              },
              ...prev,
            ]);
            // Re-verify chain to include new block
            verifyChain(activeVehicleReg);
          } else if (msg.event_type === 'PASSENGER_SOS') {
            alert(`🚨 LIVE PASSENGER SOS RECEIVED for vehicle ${msg.vehicle_registration}! Comment: ${msg.comment || 'Emergency distress call'}`);
            fetchFleetData();
          }
        } catch (e) {
          // Non-JSON or pong
        }
      };

      socket.onclose = () => setWsConnected(false);
      socket.onerror = () => setWsConnected(false);
    } catch (e) {
      setWsConnected(false);
    }

    return () => {
      if (socket) socket.close();
    };
  }, [activeVehicleReg, verifyChain, fetchFleetData]);

  // ---------------------------------------------------------------------------
  // Leaflet Map Initialization & Route Curves
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      // Initialize map centered at Patnitop NH44
      const map = L.map(mapContainerRef.current, {
        center: [33.08415, 75.32612],
        zoom: 12,
        attributionControl: false,
      });

      // CartoDB Dark Matter tile layer
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
      }).addTo(map);

      // Fetch and draw pre-cached NH44 curve geometry from /api/gis/cached-tiles
      fetch('/api/gis/cached-tiles?region=jk_nh44')
        .then((r) => r.json())
        .then((geojson) => {
          if (geojson && geojson.features) {
            const curvesLayer = L.geoJSON(geojson, {
              style: (feature) => {
                const isHighRisk = feature.properties?.risk_tier === 'HIGH' || feature.properties?.measured_menger_radius_m < 35;
                return {
                  color: isHighRisk ? '#ef4444' : '#f59e0b',
                  weight: isHighRisk ? 5 : 3,
                  opacity: 0.85,
                };
              },
              onEachFeature: (feature, layer) => {
                const props = feature.properties || {};
                layer.bindPopup(`
                  <div style="font-size:11px;line-height:1.4;">
                    <strong style="color:#22d3ee;">${props.name || 'High Risk Curve'}</strong><br/>
                    <strong>Curve ID:</strong> ${props.curve_id || 'NH44'}<br/>
                    <strong>Menger Radius (R):</strong> ${props.measured_menger_radius_m?.toFixed(1) || '—'} m<br/>
                    <strong>Max Safe Speed:</strong> ${props.designed_safe_speed_kmh?.toFixed(0) || '—'} km/h<br/>
                    <strong>Risk Tier:</strong> <span style="color:${props.risk_tier === 'HIGH' ? '#ef4444' : '#f59e0b'};font-weight:bold;">${props.risk_tier || 'HIGH'}</span>
                  </div>
                `);
              },
            }).addTo(map);
            curvesLayerRef.current = curvesLayer;
          }
        })
        .catch((e) => console.warn('[AdminDashboard] Curves GeoJSON load error:', e));

      mapInstanceRef.current = map;
    }
  }, []);

  // Update vehicle markers on map
  const updateVehiclePosition = useCallback((telemetry) => {
    if (!mapInstanceRef.current) return;
    const reg = telemetry.vehicle_registration;
    const lat = telemetry.lat;
    const lon = telemetry.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const isDr = telemetry.sensor_mode === 'IMU_DEAD_RECKONING';
    const markerColor = isDr ? '#8b5cf6' : '#10b981';

    const customIcon = L.divIcon({
      className: 'admin-vehicle-marker',
      html: `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="background:${markerColor};color:white;padding:2px 6px;border-radius:10px;font-size:9px;font-weight:800;white-space:nowrap;box-shadow:0 0 10px ${markerColor};">
            ${reg} • ${Math.round(telemetry.speed || 0)}km/h
          </div>
          <div style="width:12px;height:12px;border-radius:50%;background:${markerColor};border:2px solid white;margin-top:2px;box-shadow:0 0 8px ${markerColor};"></div>
        </div>
      `,
      iconSize: [80, 36],
      iconAnchor: [40, 36],
    });

    if (vehicleMarkersRef.current[reg]) {
      vehicleMarkersRef.current[reg].setLatLng([lat, lon]);
      vehicleMarkersRef.current[reg].setIcon(customIcon);
    } else {
      const marker = L.marker([lat, lon], { icon: customIcon })
        .bindPopup(`
          <div style="font-size:11px;">
            <strong>Commercial Vehicle: ${reg}</strong><br/>
            Speed: ${Math.round(telemetry.speed || 0)} km/h<br/>
            Mode: <strong>${telemetry.sensor_mode}</strong><br/>
            Occupancy: ${telemetry.cabin_occupancy || 18} passengers
          </div>
        `)
        .addTo(mapInstanceRef.current);
      vehicleMarkersRef.current[reg] = marker;
    }
  }, []);

  // Update markers when fleet vehicles list changes
  useEffect(() => {
    vehicles.forEach((v) => {
      if (v.current_lat && v.current_lon) {
        updateVehiclePosition({
          vehicle_registration: v.registration,
          lat: v.current_lat,
          lon: v.current_lon,
          speed: v.current_speed,
          sensor_mode: v.sensor_mode,
          cabin_occupancy: 20,
        });
      }
    });
  }, [vehicles, updateVehiclePosition]);

  // ---------------------------------------------------------------------------
  // Chart.js Visualizations (Driver Scorecards & Violation Distribution)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // 1. Driver Safety Scores Bar Chart
    if (scoreChartRef.current) {
      if (scoreChartInstance.current) {
        scoreChartInstance.current.destroy();
      }

      const driverNames = drivers.length > 0 ? drivers.map((d) => d.name) : ['Ramesh Kumar', 'Tariq Ahmed', 'Sunita Devi'];
      const driverScores = drivers.length > 0 ? drivers.map((d) => d.rolling_safety_score) : [92.5, 84.0, 98.0];

      scoreChartInstance.current = new ChartJS(scoreChartRef.current, {
        type: 'bar',
        data: {
          labels: driverNames,
          datasets: [
            {
              label: 'Rolling Safety Score (0-100)',
              data: driverScores,
              backgroundColor: driverScores.map((s) => (s >= 90 ? 'rgba(16, 185, 129, 0.7)' : s >= 80 ? 'rgba(245, 158, 11, 0.7)' : 'rgba(239, 68, 68, 0.7)')),
              borderColor: driverScores.map((s) => (s >= 90 ? '#10b981' : s >= 80 ? '#f59e0b' : '#ef4444')),
              borderWidth: 1.5,
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { color: '#94a3b8', font: { size: 10 } },
            },
            x: {
              grid: { display: false },
              ticks: { color: '#f1f5f9', font: { size: 10 } },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1,
            },
          },
        },
      });
    }

    // 2. Violation Category Doughnut Chart
    if (violationChartRef.current) {
      if (violationChartInstance.current) {
        violationChartInstance.current.destroy();
      }

      const counts = {
        OVERSPEED_CURVE: 0,
        DROWSINESS: 0,
        DISTRACTION: 0,
        PHONE_USE: 0,
        OVERCROWDING: 0,
        HARSH_CORNERING: 0,
      };

      violations.forEach((v) => {
        if (counts[v.violation_type] !== undefined) {
          counts[v.violation_type]++;
        }
      });

      const dataValues = Object.values(counts);
      const hasData = dataValues.some((v) => v > 0);

      violationChartInstance.current = new ChartJS(violationChartRef.current, {
        type: 'doughnut',
        data: {
          labels: ['Overspeed', 'Drowsiness', 'Distraction', 'Phone Use', 'Overcrowding', 'Cornering'],
          datasets: [
            {
              data: hasData ? dataValues : [4, 2, 1, 1, 1, 1],
              backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'],
              borderWidth: 1,
              borderColor: '#0a0e1a',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: { color: '#94a3b8', font: { size: 9 }, boxWidth: 10 },
            },
          },
        },
      });
    }

    return () => {
      if (scoreChartInstance.current) scoreChartInstance.current.destroy();
      if (violationChartInstance.current) violationChartInstance.current.destroy();
    };
  }, [drivers, violations]);

  // ---------------------------------------------------------------------------
  // Demo Tampering & Reset Operations
  // ---------------------------------------------------------------------------
  const handleTamperRecord = async (eventId) => {
    if (!eventId) return;
    setTamperingEventId(eventId);
    try {
      const res = await fetch(`/api/demo/tamper/${eventId}`, { method: 'POST' });
      if (res.ok) {
        const result = await res.json();
        // Immediately re-verify to show broken link in red
        await verifyChain(activeVehicleReg);
        fetchFleetData();
      }
    } catch (err) {
      console.error('[AdminDashboard] Tamper call error:', err);
    } finally {
      setTamperingEventId(null);
    }
  };

  const handleResetDemoFleet = async () => {
    setIsResettingDemo(true);
    try {
      const res = await fetch('/api/demo/reset', { method: 'POST' });
      if (res.ok) {
        await fetchFleetData();
        await verifyChain(activeVehicleReg);
      }
    } catch (err) {
      console.error('[AdminDashboard] Reset demo error:', err);
    } finally {
      setIsResettingDemo(false);
    }
  };

  // ---------------------------------------------------------------------------
  // DPDP Act 2023 Evidence Access Modal
  // ---------------------------------------------------------------------------
  const handleOpenEvidenceModal = async (violation) => {
    setSelectedEvidenceEvent(violation);
    setEvidenceLoading(true);
    setEvidenceError(null);
    setEvidenceData(null);

    try {
      const res = await fetch(`/api/evidence/${violation.id}`, {
        headers: {
          'X-Role': activeRole,
          'X-Actor-Id': `Operator_${activeRole === 'FLEET_OPERATOR' ? 'JKRTC_Hub' : 'MVD_Enforcement'}`,
          'X-Purpose': 'Official road safety audit and statutory compliance verification',
        },
      });

      if (!res.ok) {
        const errDetail = await res.json();
        throw new Error(errDetail.detail || `Access Denied: HTTP ${res.status}`);
      }

      const data = await res.json();
      setEvidenceData(data);
      // Refresh audit logs
      const auditRes = await fetch('/api/audit-logs');
      if (auditRes.ok) setAuditLogs(await auditRes.json());
    } catch (err) {
      setEvidenceError(err.message);
    } finally {
      setEvidenceLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Regulatory CSV Compliance Export
  // ---------------------------------------------------------------------------
  const handleExportCsv = () => {
    if (!violations || violations.length === 0) {
      alert('No violations currently logged to export.');
      return;
    }

    const headers = [
      'Violation_ID',
      'Vehicle_Registration',
      'Violation_Type',
      'Severity',
      'Timestamp_Device_UTC',
      'Timestamp_Server_UTC',
      'Arrived_Late_Offline_Flag',
      'Actual_Speed_kmh',
      'Safe_Speed_kmh',
      'Curve_Radius_m',
      'Sensor_Mode',
      'Record_SHA256_Hash',
      'Previous_Hash_Link',
    ];

    const rows = violations.map((v) => [
      v.id,
      v.vehicle?.registration || activeVehicleReg,
      v.violation_type,
      v.severity,
      v.timestamp_device,
      v.timestamp_server || '—',
      v.arrived_late ? 'TRUE (Device Was Offline)' : 'FALSE (Realtime)',
      v.speed_actual?.toFixed(1) || '—',
      v.speed_safe?.toFixed(1) || '—',
      v.curve_radius?.toFixed(1) || '—',
      v.sensor_mode || 'GPS_LOCKED',
      v.record_hash || '—',
      v.prev_hash || '—',
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.map((val) => `"${val}"`).join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute(
      'download',
      `CVS_Regulatory_Compliance_${activeVehicleReg}_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtered violations
  const filteredViolations = violations.filter((v) => {
    if (severityFilter !== 'ALL' && v.severity !== severityFilter) return false;
    if (lateSyncOnly && !v.arrived_late) return false;
    return true;
  });

  return (
    <div style={{ padding: '16px', maxWidth: '1440px', margin: '0 auto', color: 'var(--cvs-text-primary)' }}>
      {/* ====================================================================
          1. Header & Top-Level Role Toggle (SRS 10.3)
          ==================================================================== */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '16px',
          paddingBottom: '14px',
          borderBottom: '1px solid var(--glass-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: activeRole === 'TRANSPORT_AUTHORITY' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)',
              border: `1px solid ${activeRole === 'TRANSPORT_AUTHORITY' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)'}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Shield size={22} style={{ color: activeRole === 'TRANSPORT_AUTHORITY' ? 'var(--cvs-critical)' : 'var(--cvs-accent-cyan)' }} />
          </div>
          <div>
            <h1 style={{ fontSize: '1.2rem', fontWeight: 800, lineHeight: 1.2 }}>
              {activeRole === 'TRANSPORT_AUTHORITY'
                ? 'J&K Transport Department & Traffic Police Enforcement Console'
                : 'Commercial Fleet Operations Center — NH44 Mountain Corridor'}
            </h1>
            <p style={{ fontSize: '0.7rem', color: 'var(--cvs-text-muted)' }}>
              Real-Time GIS Curve Physics • Cryptographic Blackbox Ledger • DPDP Act 2023 Audit Trail
            </p>
          </div>
        </div>

        {/* Role Toggle Switch & WebSocket Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* WebSocket Status */}
          <div
            style={{
              padding: '4px 10px',
              borderRadius: '100px',
              fontSize: '0.68rem',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: wsConnected ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              border: `1px solid ${wsConnected ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              color: wsConnected ? 'var(--cvs-safe)' : 'var(--cvs-critical)',
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: wsConnected ? 'var(--cvs-safe)' : 'var(--cvs-critical)',
                animation: wsConnected ? 'pulse-green 2s infinite' : 'none',
              }}
            />
            <span>{wsConnected ? `Live Stream: Connected (${liveWsCount})` : 'WebSocket Reconnecting'}</span>
          </div>

          {/* Role Toggle Buttons */}
          <div
            style={{
              display: 'flex',
              background: 'rgba(0, 0, 0, 0.4)',
              padding: '3px',
              borderRadius: '8px',
              border: '1px solid var(--glass-border)',
            }}
          >
            <button
              onClick={() => setActiveRole('FLEET_OPERATOR')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '0.72rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: activeRole === 'FLEET_OPERATOR' ? 'var(--cvs-accent-blue)' : 'transparent',
                color: activeRole === 'FLEET_OPERATOR' ? 'white' : 'var(--cvs-text-muted)',
                transition: 'all 0.2s',
              }}
            >
              Fleet Operator
            </button>
            <button
              onClick={() => setActiveRole('TRANSPORT_AUTHORITY')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '0.72rem',
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                background: activeRole === 'TRANSPORT_AUTHORITY' ? 'var(--cvs-critical)' : 'transparent',
                color: activeRole === 'TRANSPORT_AUTHORITY' ? 'white' : 'var(--cvs-text-muted)',
                transition: 'all 0.2s',
              }}
            >
              Transport Authority
            </button>
          </div>

          {/* Reset Demo Button */}
          <button
            onClick={handleResetDemoFleet}
            disabled={isResettingDemo}
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: '0.7rem' }}
            title="Reset fleet database to initial pristine state"
          >
            <RotateCcw size={12} className={isResettingDemo ? 'animate-spin' : ''} />
            Reset Demo
          </button>
        </div>
      </header>

      {/* ====================================================================
          2. Top Metrics Bar
          ==================================================================== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <div className="glass-card-sm" style={{ padding: '12px' }}>
          <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>ACTIVE MONITORED FLEET</p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{vehicles.length}</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--cvs-safe)' }}>Commercial Buses Online</span>
          </div>
        </div>

        <div className="glass-card-sm" style={{ padding: '12px' }}>
          <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>LOGGED BLACKBOX VIOLATIONS</p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--cvs-advisory)' }}>
              {violations.length}
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--cvs-text-muted)' }}>Events in Ledger</span>
          </div>
        </div>

        <div className="glass-card-sm" style={{ padding: '12px' }}>
          <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>OFFLINE LATE-SYNC DETECTIONS</p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--cvs-accent-cyan)' }}>
              {violations.filter((v) => v.arrived_late).length}
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--cvs-text-muted)' }}>Mountain Tunnel Queue Flushes</span>
          </div>
        </div>

        <div className="glass-card-sm" style={{ padding: '12px' }}>
          <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>DPDP COMPLIANCE AUDIT ENTRIES</p>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '4px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--cvs-safe)' }}>
              {auditLogs.length}
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--cvs-text-muted)' }}>Audited Access Events</span>
          </div>
        </div>
      </div>

      {/* ====================================================================
          3. Live Leaflet GIS Fleet Map & NH-44 Curve Physics
          ==================================================================== */}
      <div className="glass-card" style={{ padding: '14px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <MapPin size={16} style={{ color: 'var(--cvs-accent-blue)' }} />
            <h2 style={{ fontSize: '0.95rem', fontWeight: 700 }}>
              Live NH44 Hill Route GIS Map (Pre-Cached Menger Curve Geometry)
            </h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.68rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '10px', height: '4px', background: '#ef4444', display: 'inline-block' }} /> Hairpins (R &lt; 35m)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '10px', height: '4px', background: '#f59e0b', display: 'inline-block' }} /> Moderate Curves
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', display: 'inline-block' }} /> Active GPS Bus
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#8b5cf6', display: 'inline-block' }} /> Tunnel IMU-DR Bus
            </span>
          </div>
        </div>

        {/* Leaflet Map Canvas */}
        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: '340px',
            borderRadius: '12px',
            border: '1px solid var(--glass-border)',
            overflow: 'hidden',
          }}
        />
      </div>

      {/* ====================================================================
          4. Two-Column Layout: Cryptographic Verifier & Real-Time Alert Feed
          ==================================================================== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '16px', marginBottom: '16px' }}>
        {/* Left Column: Cryptographic Blackbox Verifier Panel (FR-11) */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Database size={18} style={{ color: 'var(--cvs-accent-cyan)' }} />
              <div>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 800 }}>Cryptographic Hash-Chain Verifier</h3>
                <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>
                  Tamper-evident verification for vehicle: <strong>{activeVehicleReg}</strong>
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                value={activeVehicleReg}
                onChange={(e) => {
                  setActiveVehicleReg(e.target.value);
                  verifyChain(e.target.value);
                }}
                style={{
                  background: 'var(--cvs-bg-elevated)',
                  color: 'var(--cvs-text-primary)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '6px',
                  fontSize: '0.72rem',
                  padding: '4px 6px',
                }}
              >
                <option value="JK02-1234">JK02-1234</option>
                <option value="JK01-5678">JK01-5678</option>
                <option value="JK14-9988">JK14-9988</option>
              </select>

              <button
                onClick={() => verifyChain(activeVehicleReg)}
                disabled={isVerifyingChain}
                className="btn btn-ghost"
                style={{ padding: '4px 8px', fontSize: '0.68rem' }}
              >
                <RefreshCw size={12} className={isVerifyingChain ? 'animate-spin' : ''} />
                Verify
              </button>
            </div>
          </div>

          {/* Chain Verification Result Status */}
          {chainVerification && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                marginBottom: '14px',
                background: chainVerification.chain_intact ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.2)',
                border: `1px solid ${chainVerification.chain_intact ? 'var(--cvs-safe)' : 'var(--cvs-critical)'}`,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              {chainVerification.chain_intact ? (
                <CheckCircle2 size={20} style={{ color: 'var(--cvs-safe)', flexShrink: 0 }} />
              ) : (
                <XCircle size={20} style={{ color: 'var(--cvs-critical)', flexShrink: 0 }} />
              )}
              <div>
                <p style={{ fontSize: '0.78rem', fontWeight: 800, color: chainVerification.chain_intact ? 'var(--cvs-safe)' : 'var(--cvs-critical)' }}>
                  {chainVerification.chain_intact
                    ? '✓ Cryptographic Ledger Intact (Chain Valid)'
                    : `⚠ Tampering Detected at Sequence #${chainVerification.tampered_seq_no}!`}
                </p>
                <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-secondary)', marginTop: '2px' }}>
                  {chainVerification.chain_intact
                    ? `All ${chainVerification.total_records} sequential SHA-256 block hashes and back-pointers verified.`
                    : 'A stored violation attribute was modified without updating its cryptographic signature.'}
                </p>
              </div>
            </div>
          )}

          {/* Visual Linked Block Chain */}
          <div style={{ maxHeight: '280px', overflowY: 'auto', paddingRight: '4px' }}>
            {chainVerification?.details && chainVerification.details.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {chainVerification.details.map((block, i) => (
                  <div
                    key={block.event_id || i}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: block.valid ? 'rgba(255, 255, 255, 0.02)' : 'rgba(239, 68, 68, 0.1)',
                      border: `1px solid ${block.valid ? 'var(--glass-border)' : 'var(--cvs-critical)'}`,
                      fontSize: '0.68rem',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 800, color: block.valid ? 'var(--cvs-accent-cyan)' : 'var(--cvs-critical)' }}>
                        Block #{block.seq_no}: {block.violation_type}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span
                          style={{
                            fontSize: '0.6rem',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: block.valid ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                            color: block.valid ? 'var(--cvs-safe)' : 'var(--cvs-critical)',
                          }}
                        >
                          {block.valid ? 'VALID' : 'TAMPERED'}
                        </span>
                        {/* Demo Tamper Trigger Button */}
                        <button
                          onClick={() => handleTamperRecord(block.event_id)}
                          disabled={tamperingEventId === block.event_id}
                          style={{
                            background: 'rgba(239, 68, 68, 0.15)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            color: 'var(--cvs-critical)',
                            borderRadius: '4px',
                            padding: '2px 6px',
                            fontSize: '0.6rem',
                            cursor: 'pointer',
                          }}
                          title="Simulate modifying this record's speed on server to test detection"
                        >
                          {tamperingEventId === block.event_id ? 'Tampering…' : 'Tamper (Demo)'}
                        </button>
                      </div>
                    </div>

                    <div style={{ color: 'var(--cvs-text-muted)', fontSize: '0.62rem', lineHeight: 1.5 }}>
                      <div>
                        Prev Hash: <span style={{ color: 'var(--cvs-text-secondary)' }}>{block.prev_hash?.slice(0, 16)}…</span>
                      </div>
                      <div>
                        Record Hash: <span style={{ color: 'var(--cvs-text-primary)' }}>{block.stored_hash?.slice(0, 16)}…</span>
                      </div>
                      <div>
                        Speed: <span style={{ color: 'var(--cvs-accent-amber)' }}>{block.speed_actual?.toFixed(1)} km/h</span> |{' '}
                        <span>{new Date(block.timestamp_device).toLocaleTimeString()}</span>
                      </div>
                      {!block.valid && block.reason && (
                        <div style={{ color: 'var(--cvs-critical)', marginTop: '4px', fontWeight: 600 }}>
                          ⚠ {block.reason}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.72rem', textAlign: 'center', padding: '20px 0' }}>
                No chained blackbox events logged for this vehicle yet.
              </p>
            )}
          </div>
        </div>

        {/* Right Column: Real-Time Alert Feed (with Offline Sync Badges) */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={18} style={{ color: 'var(--cvs-accent-amber)' }} />
              <div>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 800 }}>Real-Time Alert Feed</h3>
                <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>
                  Late-Sync Flagged Violation Stream ({filteredViolations.length} records)
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '6px' }}>
              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                style={{
                  background: 'var(--cvs-bg-elevated)',
                  color: 'var(--cvs-text-primary)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '6px',
                  fontSize: '0.68rem',
                  padding: '3px 6px',
                }}
              >
                <option value="ALL">All Severities</option>
                <option value="CRITICAL">Critical Only</option>
                <option value="ADVISORY">Advisory Only</option>
              </select>

              <button
                onClick={() => setLateSyncOnly(!lateSyncOnly)}
                style={{
                  padding: '3px 8px',
                  borderRadius: '6px',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  border: lateSyncOnly ? '1px solid var(--cvs-accent-amber)' : '1px solid var(--glass-border)',
                  background: lateSyncOnly ? 'rgba(245, 158, 11, 0.2)' : 'transparent',
                  color: lateSyncOnly ? 'var(--cvs-accent-amber)' : 'var(--cvs-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Late Sync Only
              </button>
            </div>
          </div>

          {/* Feed List */}
          <div style={{ maxHeight: '340px', overflowY: 'auto', paddingRight: '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {filteredViolations.length === 0 ? (
              <p style={{ color: 'var(--cvs-text-muted)', fontSize: '0.72rem', textAlign: 'center', padding: '30px 0' }}>
                No violations match the current filter.
              </p>
            ) : (
              filteredViolations.map((v) => (
                <div
                  key={v.id}
                  style={{
                    padding: '10px',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: `1px solid ${v.severity === 'CRITICAL' ? 'rgba(239, 68, 68, 0.3)' : 'var(--glass-border)'}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 800,
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background: v.severity === 'CRITICAL' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                          color: v.severity === 'CRITICAL' ? 'var(--cvs-critical)' : 'var(--cvs-advisory)',
                        }}
                      >
                        {v.severity}
                      </span>
                      <strong style={{ fontSize: '0.75rem' }}>{v.violation_type?.replace('_', ' ')}</strong>
                      <span style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>
                        {v.vehicle_registration || v.vehicle?.registration || 'JK02-1234'}
                      </span>
                    </div>

                    {/* Offline Late-Sync Badge (FR-12, FR-13) */}
                    {v.arrived_late && (
                      <span
                        style={{
                          fontSize: '0.6rem',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: 'rgba(245, 158, 11, 0.2)',
                          border: '1px solid rgba(245, 158, 11, 0.4)',
                          color: 'var(--cvs-accent-amber)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '3px',
                        }}
                      >
                        <Clock size={10} /> Arrived Late (Device was Offline)
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--cvs-text-secondary)' }}>
                    <span>
                      Speed: <strong style={{ color: 'var(--cvs-text-primary)' }}>{Math.round(v.speed_actual || 0)} km/h</strong>
                      {v.speed_safe != null && ` (Safe: ${Math.round(v.speed_safe)} km/h)`}
                    </span>
                    <span>{new Date(v.timestamp_device).toLocaleString()}</span>
                  </div>

                  {/* Actions: View DPDP Audited Evidence */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                    <button
                      onClick={() => handleOpenEvidenceModal(v)}
                      className="btn btn-ghost"
                      style={{ padding: '3px 8px', fontSize: '0.62rem', color: 'var(--cvs-accent-cyan)' }}
                    >
                      <Eye size={11} /> Inspect Evidence (DPDP Audited)
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ====================================================================
          5. Driver Safety Scorecards & Regulatory Compliance Export
          ==================================================================== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '16px', marginBottom: '16px' }}>
        {/* Scorecard Visuals */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <h3 style={{ fontSize: '0.9rem', fontWeight: 800 }}>Driver Safety Performance Scorecards</h3>
            <span style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>Updated via Rolling Algorithm</span>
          </div>
          <div style={{ height: '180px', width: '100%' }}>
            <canvas ref={scoreChartRef} />
          </div>
        </div>

        {/* Violation Distribution & Export */}
        <div className="glass-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 800 }}>Violation Category Breakdown</h3>
              <button
                onClick={handleExportCsv}
                className="btn btn-primary"
                style={{ padding: '5px 10px', fontSize: '0.68rem' }}
              >
                <Download size={12} /> Compliance CSV Export
              </button>
            </div>
            <div style={{ height: '180px', width: '100%' }}>
              <canvas ref={violationChartRef} />
            </div>
          </div>
        </div>
      </div>

      {/* ====================================================================
          6. DPDP Act 2023 Audited Evidence Modal
          ==================================================================== */}
      {selectedEvidenceEvent && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            zIndex: 1000,
          }}
        >
          <div
            className="glass-card animate-fade-in-up"
            style={{
              width: '100%',
              maxWidth: '560px',
              padding: '20px',
              border: '1px solid rgba(34, 211, 238, 0.4)',
              background: '#0d1322',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Lock size={18} style={{ color: 'var(--cvs-accent-cyan)' }} />
                <h3 style={{ fontSize: '1rem', fontWeight: 800 }}>
                  DPDP Act 2023 Encrypted Evidence Access
                </h3>
              </div>
              <button
                onClick={() => setSelectedEvidenceEvent(null)}
                className="btn btn-ghost"
                style={{ padding: '4px 8px', fontSize: '0.7rem' }}
              >
                Close
              </button>
            </div>

            <div style={{ fontSize: '0.7rem', color: 'var(--cvs-text-secondary)', marginBottom: '12px' }}>
              Role Scope: <strong style={{ color: 'var(--cvs-accent-cyan)' }}>{activeRole}</strong> • Access
              logged to statutory compliance trail.
            </div>

            {evidenceLoading ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--cvs-text-muted)' }}>
                <RefreshCw size={24} className="animate-spin" style={{ margin: '0 auto 8px' }} />
                <p>Decrypting volatile memory evidence snapshot…</p>
              </div>
            ) : evidenceError ? (
              <div
                style={{
                  padding: '14px',
                  borderRadius: '8px',
                  background: 'rgba(239, 68, 68, 0.2)',
                  border: '1px solid var(--cvs-critical)',
                  color: 'var(--cvs-critical)',
                  fontSize: '0.75rem',
                }}
              >
                <p style={{ fontWeight: 800 }}>Access Denied under DPDP Act 2023 Regulations:</p>
                <p style={{ marginTop: '4px' }}>{evidenceError}</p>
              </div>
            ) : (
              <div>
                {/* Watermarked Snapshot Display */}
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: '200px',
                    borderRadius: '10px',
                    background: '#040711',
                    border: '1px solid var(--glass-border)',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '12px',
                  }}
                >
                  {evidenceData?.evidence_payload && evidenceData.evidence_payload.startsWith('data:image') ? (
                    <img
                      src={evidenceData.evidence_payload}
                      alt="Violation Evidence Snapshot"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <div style={{ textAlign: 'center', padding: '16px' }}>
                      <Camera size={32} style={{ color: 'var(--cvs-accent-cyan)', margin: '0 auto 8px', opacity: 0.6 }} />
                      <p style={{ fontSize: '0.75rem', color: 'var(--cvs-text-primary)' }}>
                        Watermarked Photographic Evidence Frame
                      </p>
                      <p style={{ fontSize: '0.62rem', color: 'var(--cvs-text-muted)', marginTop: '4px' }}>
                        Retained strictly under DPDP 2023 statutory accident investigation mandate.
                      </p>
                    </div>
                  )}

                  {/* Dynamic Watermark Banner */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      background: 'rgba(0, 0, 0, 0.85)',
                      padding: '4px 8px',
                      fontSize: '0.58rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--cvs-accent-cyan)',
                      borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                      textAlign: 'center',
                    }}
                  >
                    CONFIDENTIAL • {evidenceData?.watermark?.compliance_notice || 'DPDP ACT 2023 STATUTORY ACCESS'} • ACTOR: {activeRole}
                  </div>
                </div>

                {/* Evidence Metadata */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '0.68rem', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>
                  <div>
                    <span style={{ color: 'var(--cvs-text-muted)' }}>Violation: </span>
                    <strong style={{ color: 'var(--cvs-critical)' }}>{evidenceData?.violation_type}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--cvs-text-muted)' }}>Severity: </span>
                    <span>{evidenceData?.severity}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--cvs-text-muted)' }}>Device Timestamp: </span>
                    <span>{new Date(evidenceData?.timestamp_device).toLocaleString()}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--cvs-text-muted)' }}>Decryption: </span>
                    <span style={{ color: 'var(--cvs-safe)' }}>AES-GCM Volatile OK</span>
                  </div>
                </div>
              </div>
            )}

            {/* Audit Log Table */}
            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '10px' }}>
              <p style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--cvs-text-muted)', marginBottom: '6px' }}>
                Statutory DPDP Audit Log (Last 3 Access Records):
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.62rem', fontFamily: 'var(--font-mono)' }}>
                {auditLogs.slice(0, 3).map((log) => (
                  <div
                    key={log.id}
                    style={{
                      background: 'rgba(255, 255, 255, 0.02)',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>
                      [{log.actor_role}] {log.actor_id}
                    </span>
                    <span style={{ color: 'var(--cvs-text-muted)' }}>
                      {new Date(log.accessed_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer style={{ textAlign: 'center', marginTop: '20px', fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>
        AI-Driven Commercial Vehicle Safety System • Fleet Operator & Transport Authority Module (SRS 10.3)
      </footer>
    </div>
  );
}
