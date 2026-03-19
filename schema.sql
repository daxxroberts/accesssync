-- AccessSync V1 Database Schema
-- Defines the core operational tables, access adapter layer, and logs as specified in Data_Model.md
-- Engine: PostgreSQL

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------------
-- Phase 1 Foundation: Core Tables
--------------------------------------------------------

-- 1. Clients (Tenants)
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active', -- active, cancelled
    wix_site_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Plan Mappings (The Translator)
CREATE TABLE plan_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    wix_plan_id VARCHAR(255) NOT NULL,
    hardware_group_id VARCHAR(255) NOT NULL, -- The Kisi/Seam group ID mapped to this plan
    tier_name VARCHAR(50) DEFAULT 'Base', -- Base, Pro, Connect
    action VARCHAR(50) DEFAULT 'grant', -- grant, revoke, temporary
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Processed Event IDs (Idempotency / Deduplication)
CREATE TABLE processed_event_ids (
    event_id VARCHAR(255) PRIMARY KEY, -- Wix Event ID
    client_id UUID REFERENCES clients(id),
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Error Queue (Dead Letter Queue)
CREATE TABLE error_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID REFERENCES clients(id),
    member_id UUID, -- References member_identity(id)
    event_type VARCHAR(100),
    payload JSONB,
    error_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'failed', -- failed, resolved
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

--------------------------------------------------------
-- Phase 1 Foundation: Access Adapter Layer
--------------------------------------------------------

-- 5. Member Identity
CREATE TABLE member_identity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    wix_member_id VARCHAR(255) NOT NULL,
    hardware_platform VARCHAR(50) NOT NULL, -- 'seam' or 'kisi'
    hardware_user_id VARCHAR(255), -- The generated ID in Kisi/Seam
    source_tag VARCHAR(50) DEFAULT 'accesssync', -- Rule: Distinguishes from manual users
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, wix_member_id)
);

-- 6. Member Access State (Provisioning Status)
CREATE TABLE member_access_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL, -- pending_sync, in_flight, active, disabled, revoked, failed, skipped_lockdown
    role_assignment_id VARCHAR(255), -- Kisi role assignment ID - required for clean revocation
    provisioned_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id)
);

-- 7. Member Access Log (Lifecycle Events)
CREATE TABLE member_access_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL, -- provisioning_started, provisioned, provisioning_failed, disabled, restored, revoked
    credential_type VARCHAR(50), -- pin, qr, kisi_app
    credential_value TEXT, -- Encrypted PIN or QR payload
    error_code VARCHAR(50), -- E.g. CRED_001
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Adapter Admin Log (Provisioning Audit Trail)
CREATE TABLE adapter_admin_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID NOT NULL REFERENCES clients(id),
    event_type VARCHAR(100) NOT NULL,
    wix_member_id VARCHAR(255),
    hardware_user_id VARCHAR(255),
    role_assignment_id VARCHAR(255),
    result VARCHAR(50), -- success, failed
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- Phase 1 Foundation: Alert and Configuration
--------------------------------------------------------

-- 9. Config Alert Log
CREATE TABLE config_alert_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    alert_type VARCHAR(100) NOT NULL, -- missing_door, missing_group, expired_credentials, location_mismatch
    plan_mapping_id UUID REFERENCES plan_mappings(id),
    hardware_ref VARCHAR(255),
    affected_member_count INTEGER DEFAULT 0,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
