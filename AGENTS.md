# AGENTS.md — Production Engineering & Architecture Rules
## Project: AI-Driven Commercial Vehicle Safety & Violation Detection System (Mobile Edge PWA + Cloud Fleet Ecosystem)

You are a Principal Edge-AI & Full-Stack Systems Architect. All code written in this repository must adhere to strict production engineering standards, clean architecture, deterministic safety-critical math, and the functional/non-functional requirements in `./Docs/`.

---

## 1. Repository Architecture & Tech Stack
Maintain a strict separation of concerns across the monorepo:
- `Docs/` — Reference specifications (SRS, Implementation Guide, Synopsis, Patent). Read-only.
- `backend/` — Python 3.11+ FastAPI service:
  - `app/core/` — Config, environment settings (`pydantic-settings`), structured logging, security/RBAC, and cryptographic utilities.
  - `app/models/` — SQLAlchemy 2.0 typed ORM models (`Mapped`, `mapped_column`).
  - `app/schemas/` — Strict Pydantic v2 validation schemas (`ConfigDict(from_attributes=True)`).
  - `app/services/` — Pure business logic (`gis_engine.py`, `crypto_chain.py`, `safety_scorer.py`, `outbox_ingestor.py`).
  - `app/api/` — Modular FastAPI routers (`sync.py`, `telemetry.py`, `verify.py`, `gis.py`, `admin.py`, `websocket.py`).
  - `tests/` — Automated `pytest` test suite covering physics formulas, hash chains, and idempotent sync.
- `frontend/` — Mobile-first Progressive Web App (React 18+ Vite, Tailwind CSS, Lucide React, Leaflet.js, Chart.js):
  - `src/services/sensors/` — Hardware abstraction for HTML5 Geolocation, `DeviceMotionEvent` (Accelerometer/Gyroscope), `DeviceOrientationEvent`, and deterministic Route Simulator fallback.
  - `src/services/vision/` — On-device `@mediapipe/tasks-vision` (FaceLandmarker & ObjectDetector) running in-memory via WebGL/WASM.
  - `src/services/engine/` — Offline GIS map-matching, Menger curvature calculator, safe-speed physics, and Violation Arbitration state machine.
  - `src/services/storage/` — IndexedDB tamper-evident Blackbox (`crypto.subtle` SHA-256 hash chain) and offline Outbox sync worker.
  - `src/views/` — Role-isolated UI modules (`DriverMobileView`, `PassengerMobileView`, `AdminDashboardView`).

---

## 2. Production Code Quality Mandates (STRICT)
1. **Zero Placeholders or Stubs**: NEVER write `# TODO`, `pass`, `// implement later`, or return hardcoded dummy values in core engines. Every mathematical equation, sensor listener, IndexedDB transaction, and API endpoint must be 100% implemented and executable.
2. **Type Safety & Validation**:
   - Python: Use full type hints (`typing`, `Annotated`) and Pydantic v2 field validators (`Field(..., ge=0)`).
   - JavaScript/React: Validate all sensor inputs against `null`, `NaN`, or `Infinity` before feeding them into physics equations (e.g., when mobile `coords.speed` or `rotationRate` is temporarily `null`).
3. **Resilience & Error Handling**:
   - All sensor and camera hooks must gracefully handle permission denials, iOS 13+ `DeviceMotionEvent.requestPermission()` prompts, and hardware unavailability by seamlessly falling back to the interactive `SimulationController` without crashing the UI.
   - All database transactions must use proper context managers (`try / except / rollback`) and handle duplicate keys idempotently.
4. **Real-Time Performance (NFR-2)**:
   - End-to-end detection-to-alert latency must remain `< 500 ms`.
   - Avoid React state re-renders at 60 Hz for raw IMU/camera frames; use `useRef` or an event-driven ring buffer for high-frequency sensor loops and throttle UI state updates to 4–10 Hz.

---

## 3. Core 5-Stage Pipeline Specification

### Stage 1: Sense (Mobile Hardware & Telemetry Ingestion — FR-1, FR-2, FR-3)
- **GPS Stream (1–5 Hz)**: Use `navigator.geolocation.watchPosition` (`enableHighAccuracy: true, maximumAge: 0, timeout: 3000`) to capture `latitude`, `longitude`, `speed` (fallback to Haversine $\Delta d / \Delta t$ if `coords.speed` is `null`), `heading`, and `accuracy`.
- **IMU Gyroscope & Accelerometer Stream (30–60 Hz)**:
  - Capture 3-axis angular velocity (`rotationRate.alpha`, `beta`, `gamma` in deg/s) and linear acceleration (`acceleration` or low-pass gravity-compensated `accelerationIncludingGravity`).
  - Support one-tap mount calibration to zero out static cabin pitch/roll offsets.
- **Camera Streams**: Use `navigator.mediaDevices.getUserMedia` supporting front camera (`facingMode: "user"` for Driver Monitoring) and rear camera (`facingMode: "environment"` for Cabin Occupancy / Road View).

### Stage 2: Perceive (Edge Vision & IMU Dead-Reckoning — FR-4, FR-8, FR-9, NFR-1)
- **GPS-Denied IMU Dead-Reckoning (NFR-1)**:
  - When `GPS_LOCKED` (`accuracy <= 25m` and signal age `< 3s`), fuse GPS heading with integrated gyroscope yaw rate ($\omega_z$) via a complementary filter:
    $$\theta_t = 0.96 \cdot (\theta_{t-1} + \omega_z \cdot \Delta t) + 0.04 \cdot \theta_{\text{GPS}}$$
  - When GPS drops or `accuracy > 25m` (tunnels/valleys), automatically transition to `IMU_DEAD_RECKONING` (`REDUCED_CONFIDENCE` mode) for a bounded 30-second grace window:
    1. Integrate forward linear acceleration with zero-velocity clamping to estimate speed: $v_t = \max(0, v_{t-1} + a_{\text{forward}} \cdot \Delta t)$.
    2. Integrate gyroscope yaw rate to update heading: $\theta_t = (\theta_{t-1} + \omega_z \cdot \Delta t) \pmod{360}$.
    3. Project dead-reckoned coordinates along the cached road polyline using spherical earth offsets ($R_{\text{earth}} = 6,371,000\text{ m}$).
- **Driver State & Cabin Vision**:
  - **Eye Aspect Ratio (EAR)**: Compute $\text{EAR} = \frac{\Vert{}p_2 - p_6\Vert{} + \Vert{}p_3 - p_5\Vert{}}{2 \cdot \Vert{}p_1 - p_4\Vert{}}$. Candidate `DROWSINESS` when $\text{EAR} < 0.21$.
  - **Mouth Aspect Ratio (MAR)**: Candidate yawning/fatigue when $\text{MAR} > 0.60$.
  - **Head Pose**: Candidate `DISTRACTION` when $\vert{}\text{yaw}\vert{} > 30^\circ$ or $\vert{}\text{pitch}\vert{} > 25^\circ$.
  - **Phone & Occupancy**: Flag `PHONE_USE` when a mobile phone bounding box is detected near the driver; smooth detected `person` count over a 3-second rolling window against `permitted_capacity` to flag `OVERCROWDING`.

### Stage 3: Decide (GIS Curve Physics & Violation Arbitration — FR-6, FR-7, FR-13a)
- **Offline GIS Map-Matching & Menger Curvature**:
  - Pre-cache OpenStreetMap/SRTM road geometry in `IndexedDB` so curve evaluation runs with zero internet connectivity.
  - Snap position to the nearest road segment and scan 100m–300m ahead.
  - For consecutive road vertices $P_1, P_2, P_3$ projected into local meters, compute side lengths $a, b, c$, triangle area $A$ via cross product, and Menger curvature radius:
    $$R = \frac{a \cdot b \cdot c}{4 \cdot A}$$
  - Compute maximum safe curve speed:
    $$v_{\text{safe}} = 3.6 \cdot \sqrt{R \cdot g \cdot (e + f)} \quad (\text{km/h})$$
    where $g = 9.81\text{ m/s}^2$, $e = 0.07$ (superelevation), and $f = 0.15$ (conservative lateral friction limit; reduced by 15% during `IMU_DEAD_RECKONING`).
  - Compute required warning distance:
    $$d_{\text{warn}} = (v_{\text{m/s}} \cdot t_{\text{reaction}}) + \frac{v_{\text{m/s}}^2}{2 \cdot g \cdot (\mu \pm \text{gradient})}$$
    using $t_{\text{reaction}} = 2.0\text{ s}$ and $\mu = 0.35$.
- **Violation Arbitration Engine (FR-13a)**:
  - Require continuous multi-frame debouncing before confirming any violation (`DROWSINESS` $\ge 1.8\text{s}$, `DISTRACTION`/`PHONE_USE` $\ge 2.0\text{s}$, `OVERSPEED_CURVE` $\ge 1.2\text{s}$ inside $d_{\text{warn}}$, `OVERCROWDING` $\ge 5.0\text{s}$).
  - Cross-check overspeed and harsh cornering against gyroscope lateral acceleration ($a_{\text{lat}} = v \cdot \omega_z$).
  - Suppress any alert whose required sensor is degraded or offline.
  - Enforce a 15-second cooldown per violation category after an `ADVISORY` alert; escalate to `CRITICAL` if the driver does not correct the violation within 5 seconds.

### Stage 4: Act & Record (Non-Distracting Alerts & Tamper-Evident Blackbox — FR-10, FR-11, NFR-4)
- **In-Cabin Alerts (NFR-5)**: Trigger synthesized speech (`window.speechSynthesis`), offline Web Audio API dual-tone alert buzzer, and mobile haptic vibration (`navigator.vibrate`)—never require the driver to read dense text while moving.
- **Cryptographic Hash-Chained Blackbox (FR-11)**:
  - Every confirmed violation is written locally first with sequential `seq_no`, `prev_hash` (initialized to `"GENESIS_0000000000000000"` for `seq_no = 1`), and deterministic `record_hash = SHA256(prev_hash + canonical_json(payload))`.
- **Privacy by Design (NFR-4 / DPDP Act 2023)**:
  - Raw driver and cabin video streams are processed strictly in volatile memory and discarded immediately after frame inference.
  - Only violation metadata and a single compressed, watermarked evidence snapshot are retained for confirmed violations. Every evidence view on the dashboard is recorded in `AuditLog`.

### Stage 5: Sync & Show (Outbox Pattern, Rolling Score & Role-Scoped UI — FR-12, FR-13, SRS §10)
- **Idempotent Outbox Sync**:
  - Save all events locally with `synced: false` and a `UUIDv4` primary key.
  - Background worker flushes unsynced events chronologically when connectivity returns. Server ignores duplicate UUIDs and flags events where `timestamp_server - timestamp_device > 15s` as `arrived_late: true` ("Arrived Late — Device was Offline").
- **Role-Based Access Control (SRS §10)**:
  - **Driver Module (10.1)**: Shift start/end, high-contrast Speed vs. Safe Curve Speed HUD, gyroscope/GPS telemetry status, personal safety score, and manual SOS. No access to raw evidence footage.
  - **Passenger Module (10.2)**: Public route safety rating, live seat occupancy indicator, live bus tracker, passenger SOS button, and trip feedback report.
  - **Fleet Operator & Transport Authority Module (10.3)**: Live Leaflet GIS fleet map, real-time violation feed with late-sync badges, `/verify/{registration}` interactive cryptographic chain verifier, audited evidence viewer, Chart.js driver scorecards, and regulatory CSV/PDF compliance export.