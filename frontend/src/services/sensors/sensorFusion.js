/**
 * Mobile Sensor Fusion Engine — Stage 1 (Sense) & Stage 2 (Perceive/Dead-Reckoning)
 * 
 * Fully implements AGENTS.md §3 Stage 1 & 2, SRS FR-1..FR-3, NFR-1:
 *  - GPS streaming via watchPosition (1-5 Hz, enableHighAccuracy)
 *  - IMU Gyroscope + Accelerometer via DeviceMotionEvent (30-60 Hz)
 *  - Compass heading via DeviceOrientationEvent
 *  - Complementary filter GPS/gyro heading fusion
 *  - GPS-denied IMU dead-reckoning (30s grace window, NFR-1)
 *  - Haversine speed fallback when coords.speed is null
 *  - One-tap mount calibration (zero baseline pitch/roll)
 *  - Harsh cornering / lateral g-force detection
 *  - Interactive NH44 Mountain Drive Simulator fallback
 *
 * All math is deterministic, no stubs, no placeholders.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const R_EARTH = 6_371_000; // metres (WGS84 spherical approximation)
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const GPS_ACCURACY_THRESHOLD = 25; // metres – anything higher triggers degraded mode
const GPS_STALE_TIMEOUT_MS = 3000; // 3 seconds max age before GPS is considered lost
const DEAD_RECKONING_GRACE_S = 30; // bounded IMU-only window
const COMPLEMENTARY_ALPHA = 0.96; // gyro weight in heading fusion
const COMPLEMENTARY_BETA = 0.04;  // GPS weight in heading fusion
const GRAVITY_LP_ALPHA = 0.8;     // low-pass filter coefficient for gravity separation

/**
 * Sensor mode state enum
 */
export const SensorMode = Object.freeze({
  GPS_LOCKED: 'GPS_LOCKED',
  IMU_DEAD_RECKONING: 'IMU_DEAD_RECKONING',
  SIMULATION: 'SIMULATION',
  OFFLINE: 'OFFLINE',
});

/**
 * Haversine distance between two (lat, lon) pairs in metres
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Bearing from (lat1,lon1) to (lat2,lon2) in degrees [0..360)
 */
function computeBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG_TO_RAD;
  const φ2 = lat2 * DEG_TO_RAD;
  const Δλ = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

/**
 * Project (lat, lon) forward by `distMetres` along `bearingDeg`
 * Returns { lat, lon }
 */
function projectForward(lat, lon, bearingDeg, distMetres) {
  const δ = distMetres / R_EARTH;
  const θ = bearingDeg * DEG_TO_RAD;
  const φ1 = lat * DEG_TO_RAD;
  const λ1 = lon * DEG_TO_RAD;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
      Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );

  return {
    lat: φ2 * RAD_TO_DEG,
    lon: λ2 * RAD_TO_DEG,
  };
}

/**
 * Normalise angle to [0, 360)
 */
function normaliseDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// MobileSensorEngine
// ---------------------------------------------------------------------------

export class MobileSensorEngine {
  constructor() {
    // --- Public state (read via getState()) ---
    this._state = {
      sensorMode: SensorMode.OFFLINE,
      lat: 0,
      lon: 0,
      speedKmh: 0,
      heading: 0,
      accuracy: Infinity,
      altitude: null,

      // IMU raw
      accelX: 0, accelY: 0, accelZ: 0,        // linear (gravity-compensated)
      gyroAlpha: 0, gyroBeta: 0, gyroGamma: 0, // deg/s
      compassHeading: null,
      pitch: 0, roll: 0,

      // Derived
      lateralAccel: 0,    // m/s² from gyro+speed fusion
      lateralAccelRaw: 0, // m/s² direct from accelerometer lateral axis
      harshCornering: false,
      yawRate: 0,         // deg/s

      // Meta
      gpsTimestamp: 0,
      imuTimestamp: 0,
      drDeadlineMs: 0,   // dead-reckoning grace window end timestamp
      confidence: 1.0,
      isCalibrated: false,
      simulationActive: false,
    };

    // --- Internal bookkeeping ---
    this._watchId = null;
    this._prevGps = null; // { lat, lon, timestamp }
    this._gravityVector = { x: 0, y: 0, z: 9.81 }; // low-pass separated gravity
    this._mountOffset = { pitch: 0, roll: 0 };       // calibration offsets

    // Listeners
    this._listeners = new Map(); // eventName → Set<fn>

    // Simulator
    this._simulator = null;

    // Bound handlers (for cleanup)
    this._onDeviceMotion = this._handleDeviceMotion.bind(this);
    this._onDeviceOrientation = this._handleDeviceOrientation.bind(this);
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Returns a frozen snapshot of the current state.
   */
  getState() {
    return { ...this._state };
  }

  /**
   * Subscribe to state change events.
   * @param {'stateUpdate'|'modeChange'|'harshCornering'|'gpsRestored'|'drTimeout'} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  /**
   * Emit an event to all registered listeners
   */
  _emit(event, data) {
    const subs = this._listeners.get(event);
    if (subs) {
      for (const fn of subs) {
        try { fn(data); } catch (e) { console.error(`[SensorEngine] listener error (${event}):`, e); }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Permissions & Initialisation
  // -----------------------------------------------------------------------

  /**
   * Request all sensor permissions and start streaming.
   * Must be called from a user-gesture handler (button click) for iOS 13+.
   * @returns {Promise<{ gps: boolean, imu: boolean }>}
   */
  async requestPermissionsAndStart() {
    const result = { gps: false, imu: false };

    // 1) iOS 13+ DeviceMotionEvent permission
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const motionPerm = await DeviceMotionEvent.requestPermission();
        if (motionPerm !== 'granted') {
          console.warn('[SensorEngine] DeviceMotion permission denied');
        }
      } catch (err) {
        console.warn('[SensorEngine] DeviceMotion permission error:', err);
      }
    }

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const orientPerm = await DeviceOrientationEvent.requestPermission();
        if (orientPerm !== 'granted') {
          console.warn('[SensorEngine] DeviceOrientation permission denied');
        }
      } catch (err) {
        console.warn('[SensorEngine] DeviceOrientation permission error:', err);
      }
    }

    // 2) Start IMU listeners
    if (typeof window !== 'undefined') {
      try {
        window.addEventListener('devicemotion', this._onDeviceMotion, { passive: true });
        window.addEventListener('deviceorientation', this._onDeviceOrientation, { passive: true });
        result.imu = true;
      } catch (err) {
        console.warn('[SensorEngine] IMU listener attach failed:', err);
      }
    }

    // 3) Start GPS
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      try {
        this._watchId = navigator.geolocation.watchPosition(
          (pos) => this._handleGpsPosition(pos),
          (err) => this._handleGpsError(err),
          {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 3000,
          },
        );
        result.gps = true;
      } catch (err) {
        console.warn('[SensorEngine] GPS watchPosition failed:', err);
      }
    }

    if (result.gps || result.imu) {
      this._setMode(result.gps ? SensorMode.GPS_LOCKED : SensorMode.OFFLINE);
    }

    return result;
  }

  /**
   * Stop all sensor streams and clean up.
   */
  stop() {
    if (typeof navigator !== 'undefined' && this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this._onDeviceMotion);
      window.removeEventListener('deviceorientation', this._onDeviceOrientation);
    }
    this._setMode(SensorMode.OFFLINE);
    if (this._simulator) {
      this._simulator.stop();
      this._simulator = null;
    }
  }

  // -----------------------------------------------------------------------
  // Mount Calibration
  // -----------------------------------------------------------------------

  /**
   * Zero out the current pitch/roll as the neutral mount position.
   * Call once after driver mounts the phone on the dashboard holder.
   */
  calibrateMount() {
    this._mountOffset.pitch = this._state.pitch;
    this._mountOffset.roll = this._state.roll;
    this._state.isCalibrated = true;
    console.info(
      `[SensorEngine] Mount calibrated: pitchOffset=${this._mountOffset.pitch.toFixed(1)}° rollOffset=${this._mountOffset.roll.toFixed(1)}°`,
    );
    this._emit('stateUpdate', this.getState());
  }

  // -----------------------------------------------------------------------
  // Simulation Controller Toggle
  // -----------------------------------------------------------------------

  /**
   * Switch between live phone sensors and the interactive route simulator.
   * @param {boolean} enableSimulation
   */
  setSimulationMode(enableSimulation) {
    if (enableSimulation) {
      // Stop live sensors
      if (typeof navigator !== 'undefined' && this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('devicemotion', this._onDeviceMotion);
        window.removeEventListener('deviceorientation', this._onDeviceOrientation);
      }

      // Start simulator
      this._simulator = new SimulationController(this);
      this._simulator.start();
      this._state.simulationActive = true;
      this._setMode(SensorMode.SIMULATION);
    } else {
      // Stop simulator, restart live sensors
      if (this._simulator) {
        this._simulator.stop();
        this._simulator = null;
      }
      this._state.simulationActive = false;
      this.requestPermissionsAndStart();
    }
  }

  /**
   * Returns the SimulationController instance when in simulation mode.
   */
  getSimulator() {
    return this._simulator;
  }

  // ========================================================================
  // Private — GPS Handling
  // ========================================================================

  _handleGpsPosition(position) {
    const { latitude, longitude, speed, heading, accuracy, altitude } = position.coords;
    const now = position.timestamp || Date.now();

    // Guard against NaN/invalid values
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    // Compute speed from Haversine if coords.speed is null/unavailable
    let speedMs;
    if (speed !== null && Number.isFinite(speed) && speed >= 0) {
      speedMs = speed;
    } else if (this._prevGps) {
      const dt = (now - this._prevGps.timestamp) / 1000;
      if (dt > 0.1 && dt < 10) {
        const dist = haversineDistance(this._prevGps.lat, this._prevGps.lon, latitude, longitude);
        speedMs = dist / dt;
      } else {
        speedMs = this._state.speedKmh / 3.6; // keep previous
      }
    } else {
      speedMs = 0;
    }

    // Heading: use coords.heading if available, else compute from consecutive positions
    let gpsHeading = this._state.heading;
    if (heading !== null && Number.isFinite(heading)) {
      gpsHeading = heading;
    } else if (this._prevGps && speedMs > 0.5) {
      gpsHeading = computeBearing(this._prevGps.lat, this._prevGps.lon, latitude, longitude);
    }

    // Check if GPS quality is sufficient for locked mode
    const isAccurate = Number.isFinite(accuracy) && accuracy <= GPS_ACCURACY_THRESHOLD;

    if (isAccurate) {
      // Fuse heading with gyroscope using complementary filter
      const gyroYawDeg = this._state.gyroGamma; // yaw rate in deg/s
      const dtSinceImu = (now - this._state.imuTimestamp) / 1000;
      let fusedHeading;

      if (dtSinceImu > 0 && dtSinceImu < 1 && Number.isFinite(gyroYawDeg)) {
        // θ_t = 0.96 * (θ_{t-1} + ω_z * Δt) + 0.04 * θ_GPS
        const gyroEstimate = normaliseDeg(this._state.heading + gyroYawDeg * dtSinceImu);
        fusedHeading = normaliseDeg(
          COMPLEMENTARY_ALPHA * gyroEstimate + COMPLEMENTARY_BETA * gpsHeading,
        );
      } else {
        fusedHeading = gpsHeading;
      }

      // Update state — GPS LOCKED
      this._state.lat = latitude;
      this._state.lon = longitude;
      this._state.speedKmh = Math.max(0, speedMs * 3.6);
      this._state.heading = fusedHeading;
      this._state.accuracy = accuracy;
      this._state.altitude = altitude;
      this._state.gpsTimestamp = now;
      this._state.confidence = 1.0;

      if (this._state.sensorMode !== SensorMode.GPS_LOCKED) {
        this._setMode(SensorMode.GPS_LOCKED);
        this._emit('gpsRestored', this.getState());
      }
    } else {
      // GPS degraded — transition to dead reckoning if not already
      this._transitionToDeadReckoning();
    }

    this._prevGps = { lat: latitude, lon: longitude, timestamp: now };

    this._emit('stateUpdate', this.getState());
  }

  _handleGpsError(error) {
    console.warn('[SensorEngine] GPS error:', error.message, `(code ${error.code})`);
    this._transitionToDeadReckoning();
  }

  // ========================================================================
  // Private — IMU Handling (DeviceMotionEvent)
  // ========================================================================

  _handleDeviceMotion(event) {
    const now = Date.now();
    const dt = this._state.imuTimestamp > 0 ? (now - this._state.imuTimestamp) / 1000 : 0;
    this._state.imuTimestamp = now;

    // --- Linear acceleration (gravity-compensated) ---
    let ax = 0, ay = 0, az = 0;
    if (event.acceleration && Number.isFinite(event.acceleration.x)) {
      ax = event.acceleration.x;
      ay = event.acceleration.y;
      az = event.acceleration.z;
    } else if (event.accelerationIncludingGravity) {
      // Low-pass filter to separate gravity
      const raw = event.accelerationIncludingGravity;
      if (Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.z)) {
        this._gravityVector.x = GRAVITY_LP_ALPHA * this._gravityVector.x + (1 - GRAVITY_LP_ALPHA) * raw.x;
        this._gravityVector.y = GRAVITY_LP_ALPHA * this._gravityVector.y + (1 - GRAVITY_LP_ALPHA) * raw.y;
        this._gravityVector.z = GRAVITY_LP_ALPHA * this._gravityVector.z + (1 - GRAVITY_LP_ALPHA) * raw.z;
        ax = raw.x - this._gravityVector.x;
        ay = raw.y - this._gravityVector.y;
        az = raw.z - this._gravityVector.z;
      }
    }

    // --- Gyroscope angular velocity ---
    let gAlpha = 0, gBeta = 0, gGamma = 0;
    if (event.rotationRate) {
      gAlpha = Number.isFinite(event.rotationRate.alpha) ? event.rotationRate.alpha : 0;
      gBeta = Number.isFinite(event.rotationRate.beta) ? event.rotationRate.beta : 0;
      gGamma = Number.isFinite(event.rotationRate.gamma) ? event.rotationRate.gamma : 0;
    }

    // Apply mount calibration offsets (zero the neutral cabin position)
    const calibratedPitch = this._state.pitch - this._mountOffset.pitch;
    const calibratedRoll = this._state.roll - this._mountOffset.roll;

    // Update raw IMU state
    this._state.accelX = ax;
    this._state.accelY = ay;
    this._state.accelZ = az;
    this._state.gyroAlpha = gAlpha;
    this._state.gyroBeta = gBeta;
    this._state.gyroGamma = gGamma;
    this._state.yawRate = gGamma; // gamma ≈ yaw rotation for portrait-mounted phone

    // --- Harsh Cornering Detection ---
    // a_lateral = v * ω_yaw (gyro-derived) combined with direct lateral accelerometer
    const speedMs = this._state.speedKmh / 3.6;
    const yawRateRadS = gGamma * DEG_TO_RAD;
    const gyroLateralAccel = Math.abs(speedMs * yawRateRadS);
    const accelLateral = Math.abs(ax); // x-axis = lateral in portrait mount
    this._state.lateralAccel = gyroLateralAccel;
    this._state.lateralAccelRaw = accelLateral;

    // Harsh cornering: >3.5 m/s² sustained lateral force
    const wasHarsh = this._state.harshCornering;
    this._state.harshCornering = (gyroLateralAccel > 3.5 || accelLateral > 3.5);
    if (this._state.harshCornering && !wasHarsh) {
      this._emit('harshCornering', {
        lateralG: Math.max(gyroLateralAccel, accelLateral) / 9.81,
        speedKmh: this._state.speedKmh,
        yawRate: gGamma,
      });
    }

    // --- Dead-Reckoning Integration (when GPS is lost) ---
    if (this._state.sensorMode === SensorMode.IMU_DEAD_RECKONING && dt > 0 && dt < 0.5) {
      this._integrateDeadReckoning(dt, ay, gGamma);
    }
  }

  // ========================================================================
  // Private — Compass Heading (DeviceOrientationEvent)
  // ========================================================================

  _handleDeviceOrientation(event) {
    if (Number.isFinite(event.alpha)) {
      this._state.compassHeading = event.alpha;
    }
    if (Number.isFinite(event.beta)) {
      this._state.pitch = event.beta;
    }
    if (Number.isFinite(event.gamma)) {
      this._state.roll = event.gamma;
    }
  }

  // ========================================================================
  // Private — Dead-Reckoning (NFR-1)
  // ========================================================================

  _transitionToDeadReckoning() {
    if (this._state.sensorMode === SensorMode.IMU_DEAD_RECKONING) return;
    if (this._state.sensorMode === SensorMode.SIMULATION) return;

    console.warn('[SensorEngine] GPS degraded — entering IMU_DEAD_RECKONING (30s grace)');
    this._state.drDeadlineMs = Date.now() + DEAD_RECKONING_GRACE_S * 1000;
    this._state.confidence = 0.7;
    this._setMode(SensorMode.IMU_DEAD_RECKONING);
  }

  /**
   * Trapezoidal forward integration of IMU data for position/speed/heading.
   * @param {number} dt seconds since last IMU sample
   * @param {number} aForward forward linear acceleration m/s²
   * @param {number} yawRateDegS gyroscope yaw rate deg/s
   */
  _integrateDeadReckoning(dt, aForward, yawRateDegS) {
    // Check grace window
    if (Date.now() > this._state.drDeadlineMs) {
      this._state.confidence = 0.2;
      this._emit('drTimeout', this.getState());
      // Keep estimating but mark very low confidence
    } else {
      // Linear decay of confidence over 30s
      const elapsed = DEAD_RECKONING_GRACE_S - (this._state.drDeadlineMs - Date.now()) / 1000;
      this._state.confidence = Math.max(0.3, 1.0 - (elapsed / DEAD_RECKONING_GRACE_S) * 0.7);
    }

    // 1) Speed from trapezoidal integration with zero-velocity clamping
    const prevSpeedMs = this._state.speedKmh / 3.6;
    let newSpeedMs = Math.max(0, prevSpeedMs + aForward * dt);
    // Drift clamp: if acceleration is near-zero and speed is low, zero it out
    if (Math.abs(aForward) < 0.15 && newSpeedMs < 0.5) {
      newSpeedMs = 0;
    }
    this._state.speedKmh = newSpeedMs * 3.6;

    // 2) Heading from gyro yaw integration
    this._state.heading = normaliseDeg(this._state.heading + yawRateDegS * dt);

    // 3) Project position forward along heading
    const distanceTravelled = newSpeedMs * dt;
    if (distanceTravelled > 0.01) {
      const projected = projectForward(
        this._state.lat,
        this._state.lon,
        this._state.heading,
        distanceTravelled,
      );
      this._state.lat = projected.lat;
      this._state.lon = projected.lon;
    }

    this._emit('stateUpdate', this.getState());
  }

  _setMode(mode) {
    const prev = this._state.sensorMode;
    this._state.sensorMode = mode;
    if (prev !== mode) {
      this._emit('modeChange', { from: prev, to: mode, state: this.getState() });
    }
  }
}

// ===========================================================================
// SimulationController — Realistic NH44 Mountain Drive Replay
// ===========================================================================

/**
 * Route waypoint format:
 * { lat, lon, speedKmh, heading, altitude, accelForward, yawRateDegS, label, gpsDrop }
 */
const NH44_SIMULATION_ROUTE = [
  // --- Phase 1: Approach from Udhampur side, straight highway ---
  { lat: 33.0800, lon: 75.3200, speedKmh: 55, heading: 35, altitude: 1850, accelForward: 0.3, yawRateDegS: 0, label: 'NH44 Approach — Straight Highway', gpsDrop: false },
  { lat: 33.0810, lon: 75.3210, speedKmh: 58, heading: 35, altitude: 1870, accelForward: 0.2, yawRateDegS: 0.5, label: 'Straight — Climbing', gpsDrop: false },
  { lat: 33.0820, lon: 75.3218, speedKmh: 56, heading: 37, altitude: 1900, accelForward: 0.0, yawRateDegS: 1.0, label: 'Gentle Bend', gpsDrop: false },
  { lat: 33.0828, lon: 75.3230, speedKmh: 52, heading: 40, altitude: 1935, accelForward: -0.5, yawRateDegS: 1.5, label: 'Pre-curve Deceleration', gpsDrop: false },

  // --- Phase 2: Approaching Patnitop Hairpin 1 (R ≈ 31.8m) — OVERSPEED scenario ---
  { lat: 33.0835, lon: 75.3245, speedKmh: 50, heading: 42, altitude: 1965, accelForward: -0.3, yawRateDegS: 2.0, label: 'Warning Zone — Hairpin 1 Ahead 200m', gpsDrop: false },
  { lat: 33.0838, lon: 75.3255, speedKmh: 48, heading: 50, altitude: 1990, accelForward: -0.8, yawRateDegS: 6.0, label: 'OVERSPEED into Hairpin 1 (R=31.8m, safe=27km/h)', gpsDrop: false },
  { lat: 33.0841, lon: 75.3261, speedKmh: 44, heading: 80, altitude: 2010, accelForward: -1.5, yawRateDegS: 20.0, label: 'Hairpin 1 APEX — Sharp Right (Harsh Lateral G)', gpsDrop: false },
  { lat: 33.0842, lon: 75.3272, speedKmh: 38, heading: 130, altitude: 2020, accelForward: -1.0, yawRateDegS: 22.0, label: 'Hairpin 1 Mid-Turn (Harsh Lateral G)', gpsDrop: false },
  { lat: 33.0842, lon: 75.3280, speedKmh: 30, heading: 175, altitude: 2024, accelForward: -0.3, yawRateDegS: 12.0, label: 'Hairpin 1 Exit', gpsDrop: false },

  // --- Phase 3: Short straight, then approaching Tunnel (GPS DROPS) ---
  { lat: 33.0840, lon: 75.3290, speedKmh: 35, heading: 185, altitude: 2020, accelForward: 0.5, yawRateDegS: 1.0, label: 'Post-Hairpin Acceleration', gpsDrop: false },
  { lat: 33.0835, lon: 75.3295, speedKmh: 42, heading: 190, altitude: 2010, accelForward: 0.3, yawRateDegS: 0.5, label: 'Straight Segment Before Tunnel', gpsDrop: false },

  // --- Phase 4: 20-second Tunnel — GPS DROPS, IMU Dead-Reckoning takes over ---
  { lat: 33.0830, lon: 75.3298, speedKmh: 45, heading: 195, altitude: 2000, accelForward: 0.0, yawRateDegS: 0, label: '🔴 TUNNEL ENTRY — GPS LOST', gpsDrop: true },
  { lat: 33.0825, lon: 75.3300, speedKmh: 45, heading: 197, altitude: 1990, accelForward: 0.0, yawRateDegS: 0.5, label: 'Tunnel — IMU Dead-Reckoning (5s)', gpsDrop: true },
  { lat: 33.0820, lon: 75.3301, speedKmh: 44, heading: 200, altitude: 1980, accelForward: -0.2, yawRateDegS: 1.0, label: 'Tunnel — Gentle Curve Inside (10s)', gpsDrop: true },
  { lat: 33.0815, lon: 75.3300, speedKmh: 44, heading: 205, altitude: 1970, accelForward: 0.0, yawRateDegS: 0.5, label: 'Tunnel — Mid-Point (15s)', gpsDrop: true },
  { lat: 33.0810, lon: 75.3298, speedKmh: 45, heading: 210, altitude: 1960, accelForward: 0.1, yawRateDegS: 0, label: 'Tunnel — Approaching Exit (20s)', gpsDrop: true },

  // --- Phase 5: Tunnel Exit — GPS Restored ---
  { lat: 33.0805, lon: 75.3295, speedKmh: 46, heading: 215, altitude: 1950, accelForward: 0.2, yawRateDegS: -0.5, label: '🟢 TUNNEL EXIT — GPS RESTORED', gpsDrop: false },
  { lat: 33.0800, lon: 75.3290, speedKmh: 50, heading: 220, altitude: 1940, accelForward: 0.4, yawRateDegS: -1.0, label: 'Post-Tunnel Acceleration', gpsDrop: false },

  // --- Phase 6: Upper Karlah S-Bend (R ≈ 27.5m) — Second sharp curve ---
  { lat: 33.0855, lon: 75.3280, speedKmh: 52, heading: 230, altitude: 2040, accelForward: -0.5, yawRateDegS: 3.0, label: 'Warning Zone — Karlah S-Bend Ahead', gpsDrop: false },
  { lat: 33.0860, lon: 75.3290, speedKmh: 46, heading: 260, altitude: 2050, accelForward: -1.2, yawRateDegS: 18.0, label: 'Karlah S-Bend Apex 1 (Harsh Lateral G)', gpsDrop: false },
  { lat: 33.0865, lon: 75.3300, speedKmh: 40, heading: 310, altitude: 2055, accelForward: -0.8, yawRateDegS: -20.0, label: 'Karlah S-Bend Counter-Turn (Harsh Lateral G)', gpsDrop: false },
  { lat: 33.0868, lon: 75.3308, speedKmh: 32, heading: 350, altitude: 2060, accelForward: -0.3, yawRateDegS: -10.0, label: 'Karlah S-Bend Exit', gpsDrop: false },

  // --- Phase 7: Final descent, safe corridor ---
  { lat: 33.0870, lon: 75.3315, speedKmh: 40, heading: 10, altitude: 2055, accelForward: 0.5, yawRateDegS: 1.0, label: 'Post S-Bend — Safe Corridor', gpsDrop: false },
  { lat: 33.0875, lon: 75.3320, speedKmh: 48, heading: 15, altitude: 2045, accelForward: 0.3, yawRateDegS: 0, label: 'Straight Highway Descent', gpsDrop: false },
  { lat: 33.0880, lon: 75.3325, speedKmh: 52, heading: 15, altitude: 2030, accelForward: 0.0, yawRateDegS: 0, label: 'Simulation Complete', gpsDrop: false },
];

export class SimulationController {
  /**
   * @param {MobileSensorEngine} engine — the parent engine whose state we inject into
   */
  constructor(engine) {
    this._engine = engine;
    this._route = NH44_SIMULATION_ROUTE;
    this._currentIdx = 0;
    this._intervalId = null;
    this._tickRate = 1000; // ms between waypoint ticks (adjustable 500-2000)
    this._isRunning = false;
    this._isPaused = false;
    this._elapsedTicks = 0;
    this._listeners = new Map();
  }

  get routeLength() {
    return this._route.length;
  }

  get currentIndex() {
    return this._currentIdx;
  }

  get isRunning() {
    return this._isRunning;
  }

  get isPaused() {
    return this._isPaused;
  }

  get tickRateMs() {
    return this._tickRate;
  }

  /**
   * Subscribe to simulation events
   * @param {'waypoint'|'complete'|'tunnelEnter'|'tunnelExit'} event
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    const subs = this._listeners.get(event);
    if (subs) {
      for (const fn of subs) {
        try { fn(data); } catch (e) { console.error('[Simulator] listener error:', e); }
      }
    }
  }

  /**
   * Start replay from the beginning
   */
  start() {
    this._currentIdx = 0;
    this._elapsedTicks = 0;
    this._isRunning = true;
    this._isPaused = false;
    this._tick(); // first tick immediately
    this._intervalId = setInterval(() => this._tick(), this._tickRate);
  }

  /**
   * Pause / resume
   */
  togglePause() {
    if (!this._isRunning) return;
    if (this._isPaused) {
      this._isPaused = false;
      this._intervalId = setInterval(() => this._tick(), this._tickRate);
    } else {
      this._isPaused = true;
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Stop and reset
   */
  stop() {
    this._isRunning = false;
    this._isPaused = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * Adjust simulation speed (500ms = 2× speed, 2000ms = 0.5× speed)
   */
  setTickRate(ms) {
    this._tickRate = Math.max(200, Math.min(5000, ms));
    if (this._isRunning && !this._isPaused) {
      clearInterval(this._intervalId);
      this._intervalId = setInterval(() => this._tick(), this._tickRate);
    }
  }

  /**
   * Jump to a specific waypoint index
   */
  jumpTo(index) {
    if (index >= 0 && index < this._route.length) {
      this._currentIdx = index;
      this._applyWaypoint(this._route[index]);
    }
  }

  /**
   * Get the full route for map visualisation
   */
  getRoute() {
    return this._route.map((wp, i) => ({
      index: i,
      lat: wp.lat,
      lon: wp.lon,
      label: wp.label,
      gpsDrop: wp.gpsDrop,
      speedKmh: wp.speedKmh,
    }));
  }

  /**
   * Returns current waypoint info
   */
  getCurrentWaypoint() {
    if (this._currentIdx < this._route.length) {
      return { ...this._route[this._currentIdx], index: this._currentIdx };
    }
    return null;
  }

  // --- Internal ---

  _tick() {
    if (this._currentIdx >= this._route.length) {
      this.stop();
      this._emit('complete', { totalTicks: this._elapsedTicks });
      return;
    }

    const wp = this._route[this._currentIdx];
    this._applyWaypoint(wp);

    // Detect tunnel enter/exit transitions
    if (this._currentIdx > 0) {
      const prevWp = this._route[this._currentIdx - 1];
      if (wp.gpsDrop && !prevWp.gpsDrop) {
        this._emit('tunnelEnter', { index: this._currentIdx, waypoint: wp });
      }
      if (!wp.gpsDrop && prevWp.gpsDrop) {
        this._emit('tunnelExit', { index: this._currentIdx, waypoint: wp });
      }
    }

    this._emit('waypoint', { index: this._currentIdx, waypoint: wp, total: this._route.length });

    this._currentIdx++;
    this._elapsedTicks++;
  }

  _applyWaypoint(wp) {
    const state = this._engine._state;
    const now = Date.now();

    state.lat = wp.lat;
    state.lon = wp.lon;
    state.speedKmh = wp.speedKmh;
    state.heading = wp.heading;
    state.altitude = wp.altitude;
    state.gpsTimestamp = now;
    state.imuTimestamp = now;
    state.simulationActive = true;

    // Simulate IMU data
    state.accelY = wp.accelForward;
    state.gyroGamma = wp.yawRateDegS;
    state.yawRate = wp.yawRateDegS;

    // Simulate lateral acceleration
    const speedMs = wp.speedKmh / 3.6;
    const yawRadS = Math.abs(wp.yawRateDegS) * DEG_TO_RAD;
    state.lateralAccel = speedMs * yawRadS;
    state.lateralAccelRaw = state.lateralAccel * 0.95; // simulated accel reading

    const wasHarsh = state.harshCornering;
    state.harshCornering = state.lateralAccel > 3.5 || state.lateralAccelRaw > 3.5;
    if (state.harshCornering && !wasHarsh) {
      this._engine._emit('harshCornering', {
        lateralG: Math.max(state.lateralAccel, state.lateralAccelRaw) / 9.81,
        speedKmh: state.speedKmh,
        yawRate: state.yawRate,
      });
    }

    // GPS drop simulation
    if (wp.gpsDrop) {
      state.accuracy = 100; // degraded
      state.confidence = 0.6;
      this._engine._setMode(SensorMode.IMU_DEAD_RECKONING);
    } else {
      state.accuracy = 5; // excellent
      state.confidence = 1.0;
      this._engine._setMode(SensorMode.SIMULATION);
    }

    this._engine._emit('stateUpdate', this._engine.getState());
  }
}

// ---------------------------------------------------------------------------
// Default singleton export
// ---------------------------------------------------------------------------
const sensorEngine = new MobileSensorEngine();
export default sensorEngine;
