"""
SQLAlchemy 2.0 ORM Models for AI-Driven Commercial Vehicle Safety System.
Adheres strictly to SRS Section 8 entity definitions:
- Vehicle
- Driver
- ViolationEvent (Tamper-evident Blackbox ledger)
- AuditLog (DPDP Act 2023 access auditing)
- PassengerFeedback (Public transit crowdsourced safety & SOS)
"""

from datetime import datetime
from typing import List, Optional
from sqlalchemy import (
    Integer,
    String,
    Float,
    Boolean,
    DateTime,
    ForeignKey,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    registration: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    permitted_capacity: Mapped[int] = mapped_column(Integer, default=32, nullable=False)
    assigned_driver_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("drivers.id"), nullable=True
    )
    current_lat: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    current_lon: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    current_speed: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    sensor_mode: Mapped[str] = mapped_column(
        String(30), default="GPS_LOCKED", nullable=False
    )  # "GPS_LOCKED" | "IMU_DEAD_RECKONING" | "OFFLINE"
    last_seen: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relationships
    driver: Mapped[Optional["Driver"]] = relationship("Driver", back_populates="vehicles")
    violations: Mapped[List["ViolationEvent"]] = relationship(
        "ViolationEvent", back_populates="vehicle", cascade="all, delete-orphan", order_by="ViolationEvent.seq_no"
    )
    feedbacks: Mapped[List["PassengerFeedback"]] = relationship(
        "PassengerFeedback", back_populates="vehicle", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Vehicle {self.registration} (Cap: {self.permitted_capacity}, Mode: {self.sensor_mode})>"


class Driver(Base):
    __tablename__ = "drivers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    license_number: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    rolling_safety_score: Mapped[float] = mapped_column(Float, default=100.0, nullable=False)

    # Relationships
    vehicles: Mapped[List["Vehicle"]] = relationship("Vehicle", back_populates="driver")
    violations: Mapped[List["ViolationEvent"]] = relationship(
        "ViolationEvent", back_populates="driver"
    )

    def __repr__(self) -> str:
        return f"<Driver {self.name} (License: {self.license_number}, Score: {self.rolling_safety_score:.1f})>"


class ViolationEvent(Base):
    __tablename__ = "violation_events"

    # UUID primary key generated at mobile edge for idempotent Outbox deduplication
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    vehicle_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vehicles.id"), nullable=True, index=True
    )
    driver_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("drivers.id"), nullable=True, index=True
    )
    
    violation_type: Mapped[str] = mapped_column(
        String(50), nullable=False, index=True
    )  # "OVERSPEED_CURVE" | "DROWSINESS" | "DISTRACTION" | "PHONE_USE" | "OVERCROWDING" | "SOS_ALERT"
    severity: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # "ADVISORY" | "CRITICAL"
    
    timestamp_device: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    timestamp_server: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    arrived_late: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, index=True
    )  # True if (timestamp_server - timestamp_device) > 15s

    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    speed_actual: Mapped[float] = mapped_column(Float, nullable=False)  # km/h
    speed_safe: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # km/h
    curve_radius: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # meters
    confidence: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    sensor_mode: Mapped[str] = mapped_column(
        String(30), default="GPS_LOCKED", nullable=False
    )  # "GPS_LOCKED" | "IMU_DEAD_RECKONING"

    # Encrypted/watermarked evidence snapshot reference (DPDP Act 2023)
    evidence_clip_ref: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Tamper-evident cryptographic ledger chain fields (FR-11)
    prev_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    record_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    seq_no: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

    # Relationships
    vehicle: Mapped[Optional["Vehicle"]] = relationship("Vehicle", back_populates="violations")
    driver: Mapped[Optional["Driver"]] = relationship("Driver", back_populates="violations")
    audit_logs: Mapped[List["AuditLog"]] = relationship(
        "AuditLog", back_populates="violation", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return (
            f"<ViolationEvent {self.id[:8]} type={self.violation_type} "
            f"severity={self.severity} seq={self.seq_no} late={self.arrived_late}>"
        )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_role: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # "FLEET_OPERATOR" | "TRANSPORT_AUTHORITY" | "SYSTEM"
    actor_id: Mapped[str] = mapped_column(String(100), nullable=False)
    violation_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("violation_events.id"), nullable=True, index=True
    )
    accessed_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    purpose: Mapped[str] = mapped_column(
        String(255), nullable=False
    )  # Reason for viewing evidence under DPDP Act 2023

    # Relationships
    violation: Mapped[Optional["ViolationEvent"]] = relationship(
        "ViolationEvent", back_populates="audit_logs"
    )

    def __repr__(self) -> str:
        return f"<AuditLog actor={self.actor_role}:{self.actor_id} violation={self.violation_id} at={self.accessed_at}>"


class PassengerFeedback(Base):
    __tablename__ = "passenger_feedbacks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vehicle_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("vehicles.id"), nullable=False, index=True
    )
    trip_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)  # 1 to 5
    comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_sos: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    # Relationships
    vehicle: Mapped["Vehicle"] = relationship("Vehicle", back_populates="feedbacks")

    def __repr__(self) -> str:
        return f"<PassengerFeedback vehicle={self.vehicle_id} rating={self.rating} SOS={self.is_sos}>"
