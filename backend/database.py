"""
Database connection and session management for the AI Commercial Vehicle Safety System.
Supports SQLite (default) and PostgreSQL with SQLAlchemy 2.0 declarative models.
"""

import os
from typing import Generator
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker, Session

# Load database URL from environment or default to a local SQLite database
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./cvs_blackbox.db")

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    echo=False
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency yielding an isolated database session per request.
    Ensures safe rollback on uncaught exceptions and cleanup upon completion.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """
    Initializes database tables and populates baseline seed records if empty.
    """
    # Import models here to ensure they are registered with Base metadata
    from models import Vehicle, Driver, ViolationEvent, AuditLog, PassengerFeedback  # noqa: F401
    Base.metadata.create_all(bind=engine)
    
    # Auto-seed initial fleet and drivers if database is newly created
    try:
        from seed_data import seed_initial_fleet
        db = SessionLocal()
        seed_initial_fleet(db)
        db.close()
    except Exception as e:
        # Avoid crashing app initialization if seed data already exists
        pass
