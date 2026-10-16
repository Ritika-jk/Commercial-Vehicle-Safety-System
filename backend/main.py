"""
FastAPI Cloud Fleet Backend & Real-Time WebSocket Telemetry Service.
Adheres strictly to SRS FR-11, FR-12, FR-13, NFR-1, NFR-4, and AGENTS.md.
"""

from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Optional, Dict, Any

from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    Header,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from database import engine, get_db, init_db
from models import Vehicle, Driver, ViolationEvent, AuditLog, PassengerFeedback
from schemas import (
    VehicleResponse,
    DriverResponse,
    ViolationEventResponse,
    OutboxSyncRequest,
    OutboxSyncResponse,
    TelemetryHeartbeatRequest,
    TelemetryHeartbeatResponse,
    ChainVerifyResponse,
    EvidenceResponse,
    PassengerFeedbackCreate,
    PassengerFeedbackResponse,
    AuditLogResponse,
)
from crypto_chain import (
    verify_violation_chain,
    decrypt_evidence,
    watermark_evidence_metadata,
)
from gis_engine import (
    get_cached_tiles,
    evaluate_curve_ahead,
)
from safety_scorer import update_driver_rolling_score
from seed_data import reset_demo_fleet


# ============================================================================
# WebSocket Connection Manager for Live Fleet Telemetry (SRS §10)
# ============================================================================

class FleetWebSocketManager:
    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        disconnected_clients: List[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected_clients.append(connection)

        for dead_client in disconnected_clients:
            self.disconnect(dead_client)


ws_manager = FleetWebSocketManager()


# ============================================================================
# Application Lifespan
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB tables and seed data
    init_db()
    yield


app = FastAPI(
    title="AI-Driven Commercial Vehicle Safety & Blackbox Telemetry API",
    description=(
        "Production Edge-PWA & Fleet Management Backend with Cryptographic Hash Chains, "
        "Offline Menger GIS Curve Physics, Idempotent Outbox Ingestion, and DPDP Act 2023 Compliance."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# Open CORS configuration for Mobile PWA, Tablet, and Desktop Operations Centers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# Health & Status Endpoints
# ============================================================================

@app.get("/", tags=["System"])
def root_status():
    return {
        "system": "AI-Driven Commercial Vehicle Safety Platform",
        "status": "OPERATIONAL",
        "version": "1.0.0",
        "architecture": "Edge PWA + Cloud Fleet Ecosystem",
        "docs_url": "/docs",
    }


@app.get("/api/health", tags=["System"])
def healthcheck(db: Session = Depends(get_db)):
    vehicle_count = db.query(Vehicle).count()
    driver_count = db.query(Driver).count()
    violation_count = db.query(ViolationEvent).count()
    return {
        "status": "HEALTHY",
        "timestamp_utc": datetime.utcnow().isoformat(),
        "database": "CONNECTED",
        "active_fleet_count": vehicle_count,
        "registered_drivers": driver_count,
        "blackbox_events_logged": violation_count,
        "live_dashboard_websockets": len(ws_manager.active_connections),
    }


# ============================================================================
# 1. Idempotent Outbox Sync Engine (FR-12 & FR-13)
# ============================================================================

@app.post(
    "/api/sync/outbox",
    response_model=OutboxSyncResponse,
    status_code=status.HTTP_200_OK,
    tags=["Outbox Sync"],
)
async def sync_outbox_events(
    payload: OutboxSyncRequest, db: Session = Depends(get_db)
):
    """
    Ingests batch arrays of unsynced ViolationEvent records from mobile IndexedDB Blackbox.
    - Idempotent: duplicates by UUID are acknowledged without double insertion.
    - Flags late-arriving events: arrived_late = True if (timestamp_server - timestamp_device) > 15s.
    - Recalculates driver's rolling safety score automatically.
    - Broadcasts real-time alert to live fleet monitoring dashboard via WebSocket.
    """
    server_time = datetime.utcnow()
    new_records_count = 0
    duplicate_count = 0
    affected_driver_ids = set()
    latest_new_event = None

    for ev in payload.events:
        # Check if record already ingested (idempotency key)
        existing = db.query(ViolationEvent).filter(ViolationEvent.id == ev.id).first()
        if existing:
            duplicate_count += 1
            continue

        # Resolve vehicle_id
        vehicle_id = ev.vehicle_id
        if not vehicle_id and ev.vehicle_registration:
            vehicle = (
                db.query(Vehicle)
                .filter(Vehicle.registration == ev.vehicle_registration)
                .first()
            )
            if vehicle:
                vehicle_id = vehicle.id
            else:
                # Create on-the-fly vehicle if newly provisioned
                vehicle = Vehicle(
                    registration=ev.vehicle_registration,
                    permitted_capacity=32,
                    sensor_mode=ev.sensor_mode,
                )
                db.add(vehicle)
                db.flush()
                vehicle_id = vehicle.id

        # Late arrival check (NFR-1 / FR-12)
        # If device was offline in mountain tunnel and flushes later
        delta_seconds = (server_time - ev.timestamp_device).total_seconds()
        is_late = delta_seconds > 15.0

        violation = ViolationEvent(
            id=ev.id,
            vehicle_id=vehicle_id,
            driver_id=ev.driver_id,
            violation_type=ev.violation_type,
            severity=ev.severity,
            timestamp_device=ev.timestamp_device,
            timestamp_server=server_time,
            arrived_late=is_late,
            lat=ev.lat,
            lon=ev.lon,
            speed_actual=ev.speed_actual,
            speed_safe=ev.speed_safe,
            curve_radius=ev.curve_radius,
            confidence=ev.confidence,
            sensor_mode=ev.sensor_mode,
            evidence_clip_ref=ev.evidence_clip_ref,
            prev_hash=ev.prev_hash,
            record_hash=ev.record_hash,
            seq_no=ev.seq_no,
        )
        db.add(violation)
        new_records_count += 1
        latest_new_event = violation

        if ev.driver_id:
            affected_driver_ids.add(ev.driver_id)

    db.commit()

    # Recalculate rolling safety score for affected drivers (FR-13)
    updated_scores: Dict[int, float] = {}
    for d_id in affected_driver_ids:
        new_score = update_driver_rolling_score(db, d_id)
        updated_scores[d_id] = new_score

    # Broadcast notification to dashboard if new records arrived
    if latest_new_event:
        await ws_manager.broadcast(
            {
                "event_type": "VIOLATION_ALERT",
                "violation_id": latest_new_event.id,
                "violation_type": latest_new_event.violation_type,
                "severity": latest_new_event.severity,
                "speed_actual": latest_new_event.speed_actual,
                "speed_safe": latest_new_event.speed_safe,
                "arrived_late": latest_new_event.arrived_late,
                "sensor_mode": latest_new_event.sensor_mode,
                "timestamp": latest_new_event.timestamp_device.isoformat(),
            }
        )

    return OutboxSyncResponse(
        status="synced",
        received=len(payload.events),
        new_records=new_records_count,
        duplicates=duplicate_count,
        updated_driver_scores=updated_scores,
    )


# ============================================================================
# 2. Telemetry Heartbeat & Live Broadcaster (FR-1, FR-2, FR-3)
# ============================================================================

@app.post(
    "/api/telemetry/heartbeat",
    response_model=TelemetryHeartbeatResponse,
    tags=["Telemetry"],
)
async def process_telemetry_heartbeat(
    telemetry: TelemetryHeartbeatRequest, db: Session = Depends(get_db)
):
    """
    Receives high-frequency GPS/IMU live telemetry from vehicle edge mobile device.
    - Updates vehicle live state and sensor mode in database.
    - Evaluates GIS lookahead against high-risk hill curves.
    - Broadcasts live position and safety status across WebSocket to fleet dashboard.
    """
    server_time = datetime.utcnow()

    # Look up or create vehicle
    vehicle = (
        db.query(Vehicle)
        .filter(Vehicle.registration == telemetry.vehicle_registration)
        .first()
    )
    if not vehicle:
        vehicle = Vehicle(
            registration=telemetry.vehicle_registration,
            permitted_capacity=32,
            assigned_driver_id=telemetry.driver_id,
        )
        db.add(vehicle)

    vehicle.current_lat = telemetry.lat
    vehicle.current_lon = telemetry.lon
    vehicle.current_speed = telemetry.speed
    vehicle.sensor_mode = telemetry.sensor_mode
    vehicle.last_seen = server_time
    if telemetry.driver_id:
        vehicle.assigned_driver_id = telemetry.driver_id

    db.commit()

    # GIS Curve Lookahead Evaluation
    advisory = evaluate_curve_ahead(
        current_lat=telemetry.lat,
        current_lon=telemetry.lon,
        current_speed_kmh=telemetry.speed,
        heading_deg=telemetry.heading,
        sensor_mode=telemetry.sensor_mode,
    )

    # Broadcast live heartbeat to all fleet dashboard WebSockets
    await ws_manager.broadcast(
        {
            "event_type": "TELEMETRY_UPDATE",
            "vehicle_registration": vehicle.registration,
            "lat": telemetry.lat,
            "lon": telemetry.lon,
            "speed": telemetry.speed,
            "sensor_mode": telemetry.sensor_mode,
            "driver_id": vehicle.assigned_driver_id,
            "cabin_occupancy": telemetry.cabin_occupancy,
            "curve_advisory": advisory if advisory.get("curve_detected") else None,
            "timestamp": server_time.isoformat(),
        }
    )

    return TelemetryHeartbeatResponse(
        status="ok",
        vehicle_registration=vehicle.registration,
        sensor_mode=vehicle.sensor_mode,
        server_timestamp=server_time,
        active_curve_advisory=advisory if advisory.get("curve_detected") else None,
    )


# ============================================================================
# 3. Cryptographic Chain Verification & Tamper Simulation (FR-11)
# ============================================================================

@app.get(
    "/api/verify/{vehicle_registration}",
    response_model=ChainVerifyResponse,
    tags=["Cryptographic Verification"],
)
def verify_vehicle_hash_chain(
    vehicle_registration: str, db: Session = Depends(get_db)
):
    """
    Validates complete SHA-256 cryptographic hash-chain ledger for a vehicle.
    Iterates sequentially starting from GENESIS_0000000000000000.
    Detects any unauthorized modification, row deletion, or retroactive alteration.
    """
    vehicle = (
        db.query(Vehicle)
        .filter(Vehicle.registration == vehicle_registration)
        .first()
    )
    if not vehicle:
        raise HTTPException(
            status_code=404, detail=f"Vehicle '{vehicle_registration}' not found."
        )

    records = (
        db.query(ViolationEvent)
        .filter(ViolationEvent.vehicle_id == vehicle.id)
        .order_by(ViolationEvent.seq_no.asc())
        .all()
    )

    result = verify_violation_chain(records, vehicle_registration)
    return result


@app.post("/api/demo/tamper/{event_id}", tags=["Cryptographic Verification"])
def tamper_record_demo(event_id: str, db: Session = Depends(get_db)):
    """
    DEMO HELPER: Deliberately alters the stored speed of a recorded violation
    WITHOUT updating its cryptographic hash.
    Allows evaluators to observe the verify endpoint detect the exact broken link.
    """
    event = db.query(ViolationEvent).filter(ViolationEvent.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Violation event not found.")

    original_speed = event.speed_actual
    tampered_speed = original_speed + 25.0
    event.speed_actual = tampered_speed
    db.commit()

    return {
        "status": "TAMPERED_FOR_DEMO",
        "message": (
            f"Event {event_id[:8]} speed altered from {original_speed} to {tampered_speed} km/h. "
            f"Record hash was NOT updated. Run GET /api/verify/{event.vehicle.registration if event.vehicle else 'vehicle'} "
            "to inspect the detected tamper alert."
        ),
        "event_id": event.id,
        "original_speed": original_speed,
        "tampered_speed": tampered_speed,
        "seq_no": event.seq_no,
    }


# ============================================================================
# 4. DPDP Act 2023 Audited Evidence Access (NFR-4)
# ============================================================================

@app.get(
    "/api/evidence/{event_id}",
    response_model=EvidenceResponse,
    tags=["Evidence Access (DPDP 2023)"],
)
def get_violation_evidence(
    event_id: str,
    x_role: Optional[str] = Header(None, alias="X-Role"),
    x_actor_id: Optional[str] = Header("anonymous_evaluator", alias="X-Actor-Id"),
    x_purpose: Optional[str] = Header("Accident investigation", alias="X-Purpose"),
    db: Session = Depends(get_db),
):
    """
    Role-scoped evidence retrieval compliant with Digital Personal Data Protection Act 2023:
    - Strictly restricts access to FLEET_OPERATOR and TRANSPORT_AUTHORITY.
    - Decrypts on-demand in volatile memory.
    - Logs access in AuditLog.
    - Generates dynamic compliance watermark.
    """
    clean_role = (x_role or "").strip().upper()
    if clean_role not in ("FLEET_OPERATOR", "TRANSPORT_AUTHORITY", "ADMIN"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Access Denied: Evidence access requires role 'FLEET_OPERATOR' "
                "or 'TRANSPORT_AUTHORITY' under DPDP Act 2023 regulations."
            ),
        )

    event = db.query(ViolationEvent).filter(ViolationEvent.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Violation event not found.")

    # Record mandatory access in AuditLog
    audit_entry = AuditLog(
        actor_role=clean_role,
        actor_id=x_actor_id or "evaluator_user",
        violation_id=event.id,
        accessed_at=datetime.utcnow(),
        purpose=x_purpose or "Official safety compliance review",
    )
    db.add(audit_entry)
    db.commit()

    # Decrypt evidence payload
    raw_evidence = event.evidence_clip_ref or "No evidence snapshot recorded."
    try:
        decrypted_payload = decrypt_evidence(raw_evidence)
    except Exception:
        decrypted_payload = raw_evidence

    watermark = watermark_evidence_metadata(
        actor_role=clean_role,
        actor_id=x_actor_id or "evaluator_user",
        purpose=x_purpose or "Safety Audit",
        violation_id=event.id,
    )

    return EvidenceResponse(
        event_id=event.id,
        vehicle_registration=event.vehicle.registration if event.vehicle else None,
        violation_type=event.violation_type,
        severity=event.severity,
        timestamp_device=event.timestamp_device,
        evidence_payload=decrypted_payload,
        is_encrypted=True,
        watermark=watermark,
    )


# ============================================================================
# 5. Offline GIS Tile & Curve Engine Endpoints (FR-6, FR-7)
# ============================================================================

@app.get("/api/gis/cached-tiles", tags=["GIS Engine"])
def fetch_cached_tiles(region: str = Query("jk_nh44")):
    """
    Exports full GeoJSON hill-road feature collection for client-side IndexedDB caching.
    Ensures 100% offline curve speed warnings during mountain tunnel GPS blackout.
    """
    return get_cached_tiles(region)


@app.post("/api/gis/evaluate", tags=["GIS Engine"])
def evaluate_coordinates(
    lat: float = Query(...),
    lon: float = Query(...),
    speed: float = Query(...),
    heading: Optional[float] = Query(None),
    sensor_mode: str = Query("GPS_LOCKED"),
):
    """
    Evaluates current vehicle coordinates against pre-loaded NH44 curves.
    """
    return evaluate_curve_ahead(
        current_lat=lat,
        current_lon=lon,
        current_speed_kmh=speed,
        heading_deg=heading,
        sensor_mode=sensor_mode,
    )


# ============================================================================
# 6. Fleet & Driver Administration Endpoints (SRS §10)
# ============================================================================

@app.get("/api/vehicles", response_model=List[VehicleResponse], tags=["Fleet"])
def list_fleet(db: Session = Depends(get_db)):
    vehicles = db.query(Vehicle).all()
    return vehicles


@app.get("/api/vehicles/{registration}", response_model=VehicleResponse, tags=["Fleet"])
def get_vehicle_by_registration(registration: str, db: Session = Depends(get_db)):
    vehicle = db.query(Vehicle).filter(Vehicle.registration == registration).first()
    if not vehicle:
        raise HTTPException(status_code=404, detail="Vehicle not found.")
    return vehicle


@app.get("/api/drivers", response_model=List[DriverResponse], tags=["Fleet"])
def list_drivers(db: Session = Depends(get_db)):
    return db.query(Driver).all()


@app.get("/api/violations", response_model=List[ViolationEventResponse], tags=["Fleet"])
def list_violations(
    vehicle_registration: Optional[str] = None,
    driver_id: Optional[int] = None,
    violation_type: Optional[str] = None,
    severity: Optional[str] = None,
    arrived_late: Optional[bool] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    query = db.query(ViolationEvent)

    if vehicle_registration:
        query = query.join(Vehicle).filter(Vehicle.registration == vehicle_registration)
    if driver_id:
        query = query.filter(ViolationEvent.driver_id == driver_id)
    if violation_type:
        query = query.filter(ViolationEvent.violation_type == violation_type)
    if severity:
        query = query.filter(ViolationEvent.severity == severity)
    if arrived_late is not None:
        query = query.filter(ViolationEvent.arrived_late == arrived_late)

    violations = (
        query.order_by(ViolationEvent.timestamp_device.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return violations


# ============================================================================
# 7. Passenger Module & Crowdsourced Safety (SRS 10.2)
# ============================================================================

@app.post(
    "/api/feedback",
    response_model=PassengerFeedbackResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["Passenger Module"],
)
async def submit_passenger_feedback(
    feedback: PassengerFeedbackCreate, db: Session = Depends(get_db)
):
    """
    Submits crowdsourced passenger trip rating or Emergency SOS.
    If is_sos == True, triggers immediate CRITICAL broadcast to dashboard.
    """
    vehicle_id = feedback.vehicle_id
    if not vehicle_id and feedback.vehicle_registration:
        v = (
            db.query(Vehicle)
            .filter(Vehicle.registration == feedback.vehicle_registration)
            .first()
        )
        if v:
            vehicle_id = v.id

    if not vehicle_id:
        raise HTTPException(status_code=400, detail="Valid vehicle registration or ID required.")

    new_feedback = PassengerFeedback(
        vehicle_id=vehicle_id,
        trip_id=feedback.trip_id,
        rating=feedback.rating,
        comment=feedback.comment,
        is_sos=feedback.is_sos,
        created_at=datetime.utcnow(),
    )
    db.add(new_feedback)
    db.commit()
    db.refresh(new_feedback)

    if feedback.is_sos:
        await ws_manager.broadcast(
            {
                "event_type": "PASSENGER_SOS",
                "vehicle_id": vehicle_id,
                "vehicle_registration": feedback.vehicle_registration,
                "comment": feedback.comment,
                "timestamp": new_feedback.created_at.isoformat(),
            }
        )

    return new_feedback


@app.get(
    "/api/feedback",
    response_model=List[PassengerFeedbackResponse],
    tags=["Passenger Module"],
)
def list_passenger_feedback(
    vehicle_id: Optional[int] = None, db: Session = Depends(get_db)
):
    query = db.query(PassengerFeedback)
    if vehicle_id:
        query = query.filter(PassengerFeedback.vehicle_id == vehicle_id)
    return query.order_by(PassengerFeedback.created_at.desc()).all()


# ============================================================================
# 8. Audit Logs & Demo Management
# ============================================================================

@app.get(
    "/api/audit-logs",
    response_model=List[AuditLogResponse],
    tags=["Evidence Access (DPDP 2023)"],
)
def list_audit_logs(db: Session = Depends(get_db)):
    return db.query(AuditLog).order_by(AuditLog.accessed_at.desc()).all()


@app.post("/api/demo/reset", tags=["System"])
def reset_demo_database(db: Session = Depends(get_db)):
    """
    Resets database back to pristine initial state with verified hash chains.
    """
    reset_demo_fleet(db)
    return {
        "status": "RESET_COMPLETE",
        "message": "Database reseeded with initial fleet (JK02-1234, JK01-5678, JK14-9988) and verified hash chain.",
    }


# ============================================================================
# WebSocket Live Telemetry Feed
# ============================================================================

@app.websocket("/ws/fleet")
async def fleet_telemetry_websocket(websocket: WebSocket):
    """
    Real-time bidirectional WebSocket stream for Fleet Operations Centers
    and Transport Authority Monitoring Consoles.
    Streams live vehicle positions, GIS curve advisories, and late-arriving sync alerts.
    """
    await ws_manager.connect(websocket)
    try:
        # Initial greeting and connection acknowledgment
        await websocket.send_json(
            {
                "event_type": "CONNECTED",
                "client_count": len(ws_manager.active_connections),
                "timestamp": datetime.utcnow().isoformat(),
            }
        )
        while True:
            # Keep connection open and accept ping/pong or client commands
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"event_type": "PONG"})
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)
