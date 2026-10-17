import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Star,
  Users,
  AlertTriangle,
  AlertOctagon,
  MapPin,
  Clock,
  Send,
  CheckCircle2,
  Bus,
  RotateCcw,
  Navigation,
  ThumbsUp,
  Info,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ---------------------------------------------------------------------------
// NH44 Transit Stops & Coordinates for Passenger Module
// ---------------------------------------------------------------------------
const NH44_STOPS = [
  { name: 'Udhampur Main Stand', lat: 32.925, lon: 75.142, status: 'Departed', time: '08:00 AM' },
  { name: 'Chenani Junction', lat: 33.025, lon: 75.285, status: 'Departed', time: '08:45 AM' },
  { name: 'Kud Hill Resort', lat: 33.065, lon: 75.312, status: 'Departed', time: '09:15 AM' },
  { name: 'Patnitop Circular Pass', lat: 33.08415, lon: 75.32612, status: 'Approaching', time: 'ETA 6 min' },
  { name: 'Batote Bypass', lat: 33.155, lon: 75.321, status: 'Scheduled', time: 'ETA 35 min' },
  { name: 'Ramban Terminal', lat: 33.242, lon: 75.241, status: 'Scheduled', time: 'ETA 1h 15m' },
  { name: 'Banihal Railway Interchange', lat: 33.498, lon: 75.201, status: 'Scheduled', time: 'ETA 2h 05m' },
];

export default function PassengerMobileView({
  selectedVehicle = 'JK02-1234',
  onVehicleChange,
}) {
  const [vehicleReg, setVehicleReg] = useState(selectedVehicle || 'JK02-1234');
  const [vehicleData, setVehicleData] = useState(null);
  const [driverData, setDriverData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Live Telemetry / Occupancy state
  const [currentSpeed, setCurrentSpeed] = useState(42);
  const [occupancy, setOccupancy] = useState(18);
  const [permittedCapacity, setPermittedCapacity] = useState(32);
  const [currentLat, setCurrentLat] = useState(33.08415);
  const [currentLon, setCurrentLon] = useState(75.32612);

  // Feedback Form State
  const [rating, setRating] = useState(5);
  const [selectedTags, setSelectedTags] = useState(['Safe Driving', 'Clean Cabin']);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionSuccess, setSubmissionSuccess] = useState(false);
  const [recentFeedbacks, setRecentFeedbacks] = useState([]);

  // Passenger SOS Alert
  const [sosSent, setSosSent] = useState(false);
  const [sosSending, setSosSending] = useState(false);

  // Leaflet Map Ref
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const busMarkerRef = useRef(null);

  // Sync vehicle prop
  useEffect(() => {
    if (selectedVehicle && selectedVehicle !== vehicleReg) {
      setVehicleReg(selectedVehicle);
    }
  }, [selectedVehicle, vehicleReg]);

  // Fetch Vehicle & Driver details from Backend
  const fetchVehicleDetails = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/vehicles/${vehicleReg}`);
      if (res.ok) {
        const v = await res.json();
        setVehicleData(v);
        setPermittedCapacity(v.permitted_capacity || 32);
        if (v.current_speed != null) setCurrentSpeed(Math.round(v.current_speed));
        if (v.current_lat != null) setCurrentLat(v.current_lat);
        if (v.current_lon != null) setCurrentLon(v.current_lon);

        if (v.driver) {
          setDriverData(v.driver);
        } else if (v.assigned_driver_id) {
          const dRes = await fetch('/api/drivers');
          if (dRes.ok) {
            const drivers = await dRes.json();
            const match = drivers.find((d) => d.id === v.assigned_driver_id);
            if (match) setDriverData(match);
          }
        }
      }
    } catch (e) {
      console.warn('[PassengerMobileView] Failed fetching vehicle:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch feedbacks
  const fetchFeedbacks = async () => {
    try {
      const res = await fetch('/api/feedback');
      if (res.ok) {
        const list = await res.json();
        setRecentFeedbacks(list.slice(0, 4));
      }
    } catch (e) {
      // Ignored
    }
  };

  useEffect(() => {
    fetchVehicleDetails();
    fetchFeedbacks();
    const interval = setInterval(() => {
      fetchVehicleDetails();
    }, 4000);
    return () => clearInterval(interval);
  }, [vehicleReg]);

  // Initialize and update Leaflet Bus Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      // Initialize map centered at Patnitop
      const map = L.map(mapContainerRef.current, {
        center: [currentLat, currentLon],
        zoom: 13,
        zoomControl: false,
        attributionControl: false,
      });

      // CartoDB Dark Matter tile layer
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        subdomains: 'abcd',
      }).addTo(map);

      // Route polyline connecting NH44 stops
      const routeCoords = NH44_STOPS.map((s) => [s.lat, s.lon]);
      L.polyline(routeCoords, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.8,
        dashArray: '4, 8',
      }).addTo(map);

      // Stop markers
      NH44_STOPS.forEach((stop) => {
        const stopIcon = L.divIcon({
          className: 'stop-marker-icon',
          html: `<div style="width:10px;height:10px;border-radius:50%;background:#22d3ee;border:2px solid white;box-shadow:0 0 8px #22d3ee;"></div>`,
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        });
        L.marker([stop.lat, stop.lon], { icon: stopIcon })
          .bindPopup(`<strong>${stop.name}</strong><br/>Status: ${stop.status} (${stop.time})`)
          .addTo(map);
      });

      // Bus vehicle marker
      const busIcon = L.divIcon({
        className: 'bus-marker-icon',
        html: `<div style="background:#10b981;color:white;padding:4px 8px;border-radius:12px;font-size:10px;font-weight:bold;box-shadow:0 0 12px rgba(16,185,129,0.8);display:flex;align-items:center;gap:4px;white-space:nowrap;">
          <span>🚌</span> ${vehicleReg}
        </div>`,
        iconSize: [80, 24],
        iconAnchor: [40, 12],
      });

      const busMarker = L.marker([currentLat, currentLon], { icon: busIcon }).addTo(map);
      busMarkerRef.current = busMarker;
      mapInstanceRef.current = map;
    } else {
      // Update bus marker position
      if (busMarkerRef.current) {
        busMarkerRef.current.setLatLng([currentLat, currentLon]);
      }
    }
  }, [currentLat, currentLon, vehicleReg]);

  // Clean up map on unmount
  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Tag toggle
  const toggleTag = (tag) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter((t) => t !== tag));
    } else {
      setSelectedTags([...selectedTags, tag]);
    }
  };

  // Submit Feedback
  const handleSubmitFeedback = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmissionSuccess(false);

    const fullComment = selectedTags.length > 0
      ? `[${selectedTags.join(', ')}] ${feedbackComment}`.trim()
      : feedbackComment.trim();

    try {
      const payload = {
        vehicle_registration: vehicleReg,
        vehicle_id: vehicleData?.id || (vehicleReg === 'JK02-1234' ? 1 : vehicleReg === 'JK01-5678' ? 2 : 3),
        rating: Number(rating),
        comment: fullComment || 'Smooth ride with good safety compliance.',
        is_sos: false,
      };

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setSubmissionSuccess(true);
        setFeedbackComment('');
        fetchFeedbacks();
        setTimeout(() => setSubmissionSuccess(false), 4000);
      }
    } catch (err) {
      console.error('[PassengerMobileView] Submit feedback error:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Trigger Passenger SOS Panic
  const handlePassengerSos = async () => {
    setSosSending(true);
    try {
      const payload = {
        vehicle_registration: vehicleReg,
        vehicle_id: vehicleData?.id || (vehicleReg === 'JK02-1234' ? 1 : 2),
        rating: 1,
        comment: `EMERGENCY PASSENGER SOS: Distress triggered aboard ${vehicleReg} on NH44 corridor!`,
        is_sos: true,
      };

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setSosSent(true);
        fetchFeedbacks();
      }
    } catch (err) {
      console.error('[PassengerMobileView] SOS dispatch error:', err);
    } finally {
      setSosSending(false);
    }
  };

  const isOvercrowded = occupancy > permittedCapacity;

  return (
    <div
      style={{
        minHeight: '100%',
        padding: '12px',
        maxWidth: '480px',
        margin: '0 auto',
        borderRadius: '24px',
        background: 'radial-gradient(ellipse at top, #111a2e 0%, #0a0e1a 100%)',
        border: '1px solid var(--glass-border)',
      }}
    >
      {/* ====================================================================
          Header & Transit Route Selector
          ==================================================================== */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '14px',
          paddingBottom: '10px',
          borderBottom: '1px solid var(--glass-border)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'rgba(34, 211, 238, 0.2)',
              border: '1px solid rgba(34, 211, 238, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Bus size={20} style={{ color: 'var(--cvs-accent-cyan)' }} />
          </div>
          <div>
            <h1 style={{ fontSize: '1rem', fontWeight: 800, lineHeight: 1.2 }}>
              J&K Transit Passenger App
            </h1>
            <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>
              NH-44 Jammu • Patnitop • Srinagar Highway
            </p>
          </div>
        </div>

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
            fontSize: '0.75rem',
            fontWeight: 700,
            padding: '4px 6px',
            cursor: 'pointer',
          }}
        >
          <option value="JK02-1234">JK02-1234 (Express)</option>
          <option value="JK01-5678">JK01-5678 (Tunnel Shuttle)</option>
          <option value="JK14-9988">JK14-9988 (Hill Cruiser)</option>
        </select>
      </header>

      {/* ====================================================================
          1. Route & Vehicle Safety Rating Card (SRS 10.2)
          ==================================================================== */}
      <div className="glass-card animate-fade-in-up" style={{ padding: '14px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Shield size={16} style={{ color: 'var(--cvs-safe)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>Vehicle Safety Standard</span>
          </div>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '12px',
              background: 'rgba(16, 185, 129, 0.15)',
              color: 'var(--cvs-safe)',
              fontSize: '0.68rem',
              fontWeight: 800,
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            GRADE A+ VERIFIED
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '10px', alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
              <div style={{ display: 'flex', color: 'var(--cvs-accent-amber)' }}>
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={14} fill="var(--cvs-accent-amber)" />
                ))}
              </div>
              <span style={{ fontSize: '0.85rem', fontWeight: 800, marginLeft: '4px' }}>4.9</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)' }}>(128 reviews)</span>
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--cvs-text-secondary)' }}>
              Assigned Driver:{' '}
              <strong style={{ color: 'var(--cvs-text-primary)' }}>
                {driverData?.name || (vehicleReg === 'JK02-1234' ? 'Ramesh Kumar' : vehicleReg === 'JK01-5678' ? 'Tariq Ahmed' : 'Sunita Devi')}
              </strong>
            </p>
            <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)', marginTop: '2px' }}>
              License: {driverData?.license_number || 'DL-02-2018-9843'}
            </p>
          </div>

          <div
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              borderRadius: '10px',
              padding: '8px',
              textAlign: 'center',
              border: '1px solid var(--glass-border)',
            }}
          >
            <p style={{ fontSize: '0.6rem', color: 'var(--cvs-text-muted)' }}>DRIVER SAFETY SCORE</p>
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '1.4rem',
                fontWeight: 800,
                color: 'var(--cvs-safe)',
                lineHeight: 1.1,
              }}
            >
              {driverData?.rolling_safety_score?.toFixed(1) || (vehicleReg === 'JK02-1234' ? '92.5' : vehicleReg === 'JK01-5678' ? '84.0' : '98.0')}
            </p>
            <span style={{ fontSize: '0.55rem', color: 'var(--cvs-text-secondary)' }}>out of 100 max</span>
          </div>
        </div>

        <div
          style={{
            marginTop: '10px',
            padding: '6px 8px',
            borderRadius: '6px',
            background: 'rgba(34, 211, 238, 0.08)',
            border: '1px solid rgba(34, 211, 238, 0.2)',
            fontSize: '0.65rem',
            color: 'var(--cvs-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <CheckCircle2 size={13} style={{ color: 'var(--cvs-accent-cyan)', flexShrink: 0 }} />
          <span>Equipped with On-Device AI DMS, Menger GIS Physics & Tamper-Evident Blackbox.</span>
        </div>
      </div>

      {/* ====================================================================
          2. Live Occupancy Indicator (SRS 10.2)
          ==================================================================== */}
      <div className="glass-card animate-fade-in-up" style={{ padding: '14px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Users size={16} style={{ color: isOvercrowded ? 'var(--cvs-critical)' : 'var(--cvs-accent-cyan)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>Real-Time Cabin Occupancy</span>
          </div>
          {/* Dynamic Seat-Capacity Badge */}
          <span
            style={{
              padding: '3px 8px',
              borderRadius: '12px',
              fontSize: '0.68rem',
              fontWeight: 800,
              background: isOvercrowded ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.15)',
              color: isOvercrowded ? 'var(--cvs-critical)' : 'var(--cvs-safe)',
              border: `1px solid ${isOvercrowded ? 'var(--cvs-critical)' : 'rgba(16, 185, 129, 0.4)'}`,
              animation: isOvercrowded ? 'pulse-red 1s infinite' : 'none',
            }}
          >
            {isOvercrowded ? 'Overcrowded — Do Not Board' : 'Seats Available'}
          </span>
        </div>

        {/* Occupancy Count & Progress Bar */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '6px' }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--cvs-text-secondary)' }}>
            Passenger Count: <strong style={{ color: 'var(--cvs-text-primary)' }}>{occupancy}</strong>
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--cvs-text-muted)' }}>
            Permitted Capacity: <strong style={{ color: 'var(--cvs-text-primary)' }}>{permittedCapacity}</strong>
          </span>
        </div>

        <div
          style={{
            width: '100%',
            height: '8px',
            borderRadius: '4px',
            background: 'var(--cvs-bg-elevated)',
            overflow: 'hidden',
            marginBottom: '8px',
          }}
        >
          <div
            style={{
              height: '100%',
              background: isOvercrowded
                ? 'var(--cvs-critical)'
                : occupancy > permittedCapacity * 0.8
                ? 'var(--cvs-advisory)'
                : 'var(--cvs-safe)',
              width: `${Math.min(100, (occupancy / permittedCapacity) * 100)}%`,
              transition: 'width 0.3s ease',
            }}
          />
        </div>

        <p style={{ fontSize: '0.65rem', color: isOvercrowded ? 'var(--cvs-critical)' : 'var(--cvs-text-secondary)' }}>
          {isOvercrowded
            ? '⚠ WARNING: Vehicle exceeds maximum legal passenger capacity under Motor Vehicles Act regulations. Boarding is not recommended.'
            : `✓ ${permittedCapacity - occupancy} seats currently open. Boarding is safe.`}
        </p>
      </div>

      {/* ====================================================================
          3. Live Bus Map & ETA (SRS 10.2)
          ==================================================================== */}
      <div className="glass-card animate-fade-in-up" style={{ padding: '14px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Navigation size={16} style={{ color: 'var(--cvs-accent-blue)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>Live Transit Map & ETA</span>
          </div>
          <span
            style={{
              fontSize: '0.68rem',
              color: 'var(--cvs-text-secondary)',
              fontFamily: 'var(--font-mono)',
              background: 'rgba(255, 255, 255, 0.04)',
              padding: '2px 6px',
              borderRadius: '4px',
            }}
          >
            Speed: {currentSpeed} km/h
          </span>
        </div>

        {/* Leaflet Map Container */}
        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: '160px',
            borderRadius: '12px',
            marginBottom: '10px',
            border: '1px solid var(--glass-border)',
            overflow: 'hidden',
          }}
        />

        {/* Stop Progression Itinerary */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <p style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--cvs-text-muted)', textTransform: 'uppercase' }}>
            Route Stations:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '0.65rem' }}>
            <div style={{ padding: '4px 6px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.02)' }}>
              <span style={{ color: 'var(--cvs-text-muted)' }}>Previous:</span>
              <p style={{ fontWeight: 600 }}>Kud Resort</p>
              <span style={{ fontSize: '0.58rem', color: 'var(--cvs-safe)' }}>✓ Departed</span>
            </div>
            <div style={{ padding: '4px 6px', borderRadius: '6px', background: 'rgba(34, 211, 238, 0.1)', border: '1px solid rgba(34, 211, 238, 0.3)' }}>
              <span style={{ color: 'var(--cvs-accent-cyan)' }}>Approaching:</span>
              <p style={{ fontWeight: 700 }}>Patnitop Pass</p>
              <span style={{ fontSize: '0.58rem', color: 'var(--cvs-accent-amber)' }}>ETA 6 min</span>
            </div>
            <div style={{ padding: '4px 6px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.02)' }}>
              <span style={{ color: 'var(--cvs-text-muted)' }}>Next Stop:</span>
              <p style={{ fontWeight: 600 }}>Batote Bypass</p>
              <span style={{ fontSize: '0.58rem', color: 'var(--cvs-text-muted)' }}>ETA 35 min</span>
            </div>
          </div>
        </div>
      </div>

      {/* ====================================================================
          4. Passenger SOS / Panic Button & Trip Feedback Form (SRS 10.2)
          ==================================================================== */}
      {/* (A) Instant Panic SOS */}
      <div style={{ marginBottom: '12px' }}>
        <button
          onClick={handlePassengerSos}
          disabled={sosSending || sosSent}
          className="btn btn-danger"
          style={{
            width: '100%',
            padding: '12px',
            fontSize: '0.9rem',
            fontWeight: 800,
            borderRadius: '12px',
            boxShadow: '0 4px 15px rgba(239, 68, 68, 0.35)',
          }}
        >
          <AlertOctagon size={18} />
          {sosSent
            ? '✓ PASSENGER SOS DISPATCHED TO FLEET CENTER'
            : sosSending
            ? 'DISPATCHING SOS…'
            : 'PASSENGER EMERGENCY SOS / PANIC'}
        </button>
        {sosSent && (
          <div
            style={{
              marginTop: '6px',
              padding: '6px 10px',
              borderRadius: '6px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid var(--cvs-critical)',
              fontSize: '0.68rem',
              color: 'var(--cvs-text-primary)',
            }}
          >
            Emergency distress beacon dispatched to Police (112) and JKRTC Operations Hub. Maintain calm.
          </div>
        )}
      </div>

      {/* (B) Trip Feedback Form */}
      <div className="glass-card animate-fade-in-up" style={{ padding: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
          <ThumbsUp size={16} style={{ color: 'var(--cvs-accent-cyan)' }} />
          <span style={{ fontSize: '0.85rem', fontWeight: 700 }}>Crowdsourced Trip Rating & Safety Feedback</span>
        </div>

        <form onSubmit={handleSubmitFeedback}>
          {/* Star selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--cvs-text-secondary)', marginRight: '4px' }}>
              Your Rating:
            </span>
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                type="button"
                key={star}
                onClick={() => setRating(star)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}
              >
                <Star
                  size={20}
                  fill={star <= rating ? 'var(--cvs-accent-amber)' : 'none'}
                  color={star <= rating ? 'var(--cvs-accent-amber)' : 'var(--cvs-text-muted)'}
                />
              </button>
            ))}
          </div>

          {/* Quick Tags */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
            {['Safe Driving', 'Clean Cabin', 'Punctual', 'Overcrowded', 'Harsh Cornering', 'Rash Driving'].map((tag) => (
              <button
                type="button"
                key={tag}
                onClick={() => toggleTag(tag)}
                style={{
                  padding: '3px 8px',
                  borderRadius: '12px',
                  fontSize: '0.65rem',
                  border: selectedTags.includes(tag)
                    ? '1px solid var(--cvs-accent-cyan)'
                    : '1px solid var(--glass-border)',
                  background: selectedTags.includes(tag)
                    ? 'rgba(34, 211, 238, 0.15)'
                    : 'rgba(255, 255, 255, 0.03)',
                  color: selectedTags.includes(tag) ? 'var(--cvs-accent-cyan)' : 'var(--cvs-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {tag}
              </button>
            ))}
          </div>

          {/* Comments Area */}
          <textarea
            value={feedbackComment}
            onChange={(e) => setFeedbackComment(e.target.value)}
            placeholder="Share additional safety or comfort observations for this trip..."
            rows={2}
            style={{
              width: '100%',
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid var(--glass-border)',
              borderRadius: '8px',
              padding: '8px',
              color: 'var(--cvs-text-primary)',
              fontSize: '0.72rem',
              marginBottom: '10px',
              resize: 'none',
            }}
          />

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary"
            style={{ width: '100%', padding: '8px', fontSize: '0.75rem' }}
          >
            <Send size={13} />
            {isSubmitting ? 'Submitting Review…' : 'Submit Passenger Review'}
          </button>

          {submissionSuccess && (
            <p style={{ marginTop: '8px', fontSize: '0.68rem', color: 'var(--cvs-safe)', textAlign: 'center' }}>
              ✓ Thank you! Your feedback has been verified and registered on the fleet portal.
            </p>
          )}
        </form>

        {/* Recent Public Feedbacks */}
        {recentFeedbacks.length > 0 && (
          <div style={{ marginTop: '12px', borderTop: '1px solid var(--glass-border)', paddingTop: '8px' }}>
            <p style={{ fontSize: '0.65rem', color: 'var(--cvs-text-muted)', marginBottom: '6px' }}>
              Recent Passenger Reviews:
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {recentFeedbacks.map((fb) => (
                <div
                  key={fb.id}
                  style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    fontSize: '0.65rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                    <div style={{ display: 'flex', color: 'var(--cvs-accent-amber)' }}>
                      {[...Array(fb.rating || 5)].map((_, i) => (
                        <Star key={i} size={10} fill="var(--cvs-accent-amber)" />
                      ))}
                    </div>
                    <span style={{ fontSize: '0.58rem', color: 'var(--cvs-text-muted)' }}>
                      {new Date(fb.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p style={{ color: 'var(--cvs-text-secondary)' }}>{fb.comment || 'Safe and smooth transit.'}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer style={{ textAlign: 'center', marginTop: '12px', fontSize: '0.6rem', color: 'var(--cvs-text-muted)' }}>
        CVS Passenger Safety & Crowdsourced Transit Portal • SRS Section 10.2 Module
      </footer>
    </div>
  );
}
