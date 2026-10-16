# AI-Driven Commercial Vehicle Safety & Violation Detection System — Backend

Production-grade FastAPI service providing cryptographic Blackbox verification, GIS mountain curve physics calculation, idempotent edge Outbox synchronization, and real-time fleet WebSocket telemetry.

---

## Architecture & Specifications

This backend adheres strictly to the system requirements outlined in `AGENTS.md` and `Docs/` (FR-11, FR-12, FR-13, NFR-1, NFR-4):

1. **Tamper-Evident Blackbox Ledger (FR-11)**:
   - SHA-256 sequential cryptographic hash chains linking from `"GENESIS_0000000000000000"`.
   - Verified via `GET /api/verify/{vehicle_registration}`.
   - Live evaluator demo endpoint: `POST /api/demo/tamper/{event_id}`.

2. **Offline GIS Curve & Safe-Speed Engine (FR-6, FR-7, NFR-1)**:
   - 3-point Menger Curvature calculator: $R = \frac{a \cdot b \cdot c}{4 \cdot \text{Area}}$.
   - Safe curve negotiation speed: $v_{\text{safe}} = 3.6 \cdot \sqrt{R \cdot g \cdot (e + f)}$.
   - Conservative lateral friction $f = 0.15$ automatically reduced by 15% ($f = 0.1275$) when vehicle is in `IMU_DEAD_RECKONING` mode.
   - Dynamic advance warning distance: $d_{\text{warn}} = (v_{\text{m/s}} \cdot t_{\text{reaction}}) + \frac{v_{\text{m/s}}^2}{2 \cdot g \cdot (\mu \pm \text{gradient})}$.
   - Cached tiles download for mobile edge offline operation: `GET /api/gis/cached-tiles?region=jk_nh44`.

3. **Idempotent Outbox Synchronization (FR-12)**:
   - Batch ingestion of mobile IndexedDB events via `POST /api/sync/outbox`.
   - Duplicate prevention based on client-generated UUID primary keys.
   - Automatic late arrival detection (`arrived_late = True`) if $(t_{\text{server}} - t_{\text{device}}) > 15\text{ s}$ when flushing queued tunnel events.

4. **Driver Rolling Safety Score (FR-13)**:
   - Dynamic score adjustment (0–100) factoring in violation severity (CRITICAL vs ADVISORY), category weights, and time decay.

5. **DPDP Act 2023 Compliant Evidence Retrieval (NFR-4)**:
   - AES-256 / authenticated keystream encryption at rest.
   - Strict role-based access control (`FLEET_OPERATOR`, `TRANSPORT_AUTHORITY`).
   - Every evidence access logged in `AuditLog` with dynamic cryptographic watermarks.

---

## Directory Structure

```text
backend/
├── database.py              # SQLite & PostgreSQL connection and session management
├── models.py                # SQLAlchemy 2.0 ORM models (Vehicle, Driver, ViolationEvent, AuditLog, PassengerFeedback)
├── schemas.py               # Pydantic v2 schemas for request validation & response serialization
├── crypto_chain.py          # SHA-256 canonical hash chaining, verification & AES encryption
├── gis_engine.py            # Menger curvature, safe speed physics & NH44 Patnitop GeoJSON
├── safety_scorer.py         # FR-13 driver rolling safety score engine
├── seed_data.py             # Baseline fleet (JK02-1234, JK01-5678, JK14-9988) and pre-verified hash chains
├── main.py                  # FastAPI application, WebSocket manager & API endpoints
├── requirements.txt         # Production dependencies
├── tests/
│   └── test_backend.py      # Automated pytest suite for physics, crypto, sync & DPDP
└── README.md
```

---

## Quickstart

### 1. Install Dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 2. Start the Backend Server
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
- Interactive Swagger UI: `http://localhost:8000/docs`
- Interactive ReDoc: `http://localhost:8000/redoc`
- WebSocket Telemetry: `ws://localhost:8000/ws/fleet`

### 3. Run Automated Tests
```bash
pytest tests/ -v
```

---

## Key API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | System health, database connection, fleet stats |
| `POST` | `/api/sync/outbox` | Idempotent Outbox batch ingestion & late sync detection |
| `POST` | `/api/telemetry/heartbeat` | Live vehicle GPS/IMU stream + WebSocket broadcast |
| `GET` | `/api/verify/{registration}` | Validates SHA-256 cryptographic Blackbox hash chain |
| `POST` | `/api/demo/tamper/{event_id}` | Tamper simulation for live evaluation |
| `GET` | `/api/evidence/{event_id}` | DPDP Act 2023 role-authorized evidence access |
| `GET` | `/api/gis/cached-tiles` | Pre-cached NH44 mountain curve geometry for offline PWA |
| `POST` | `/api/gis/evaluate` | Real-time road lookahead curve analyzer |
| `GET` | `/api/vehicles` | List all vehicles with live location and sensor mode |
| `GET` | `/api/drivers` | List drivers with rolling safety scores |
| `POST` | `/api/feedback` | Passenger crowdsourced rating and Emergency SOS |
| `GET` | `/api/audit-logs` | DPDP Act 2023 evidence viewing compliance records |
| `POST` | `/api/demo/reset` | Resets demo vehicles & hash chains to pristine state |
| `WS` | `/ws/fleet` | Real-time bidirectional fleet telemetry stream |
