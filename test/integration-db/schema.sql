-- Production schema snapshot for the real-database integration tests.
--
-- Generated 2026-10-19 from the live Supabase catalog (public schema: tables, defaults,
-- constraints, indexes; no functions, triggers, policies or enums exist there). Schema
-- only — no rows. The two _bak_20261005_* backup tables are left out.
--
-- Regenerate when a migration changes a table these tests touch; the CHECK constraints on
-- member_access.status and member_access_sources.status are the ones that matter most.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE activity_event (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  trace_id character varying(36) NOT NULL,
  ts timestamp with time zone DEFAULT now() NOT NULL,
  client_id uuid,
  actor_type character varying(20) NOT NULL,
  actor_id character varying(64) NOT NULL,
  action character varying(80) NOT NULL,
  target_type character varying(40),
  target_id character varying(64),
  result character varying(20) DEFAULT 'success'::character varying NOT NULL,
  diff jsonb,
  request_meta jsonb
);

CREATE TABLE adapter_admin_log (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  event_type character varying(100) NOT NULL,
  platform_member_id character varying(255),
  hardware_user_id character varying(255),
  role_assignment_id character varying(255),
  result character varying(50),
  configured_by character varying(255),
  configured_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  admin_action character varying(100),
  details jsonb,
  target_entity character varying(50),
  target_id uuid,
  trace_id character varying(36),
  actor_type character varying(20),
  actor_id character varying(64)
);

CREATE TABLE as_client_subscriptions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid,
  term_id uuid,
  status character varying(50) DEFAULT 'trial'::character varying NOT NULL,
  override_active boolean DEFAULT false NOT NULL,
  override_reason text,
  override_set_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE as_subscription_terms (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  name character varying(100) NOT NULL,
  billing_cadence character varying(50),
  base_price numeric(10,2),
  discount_amount numeric(10,2),
  discount_percent numeric(5,2),
  is_free boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  effective_start timestamp with time zone,
  effective_end timestamp with time zone,
  description text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE billing_subscriptions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  location_id uuid,
  tier character varying(50),
  status character varying(50) DEFAULT 'active'::character varying NOT NULL,
  subscribed_at timestamp with time zone,
  wix_subscription_id character varying(255),
  effective_start timestamp with time zone,
  effective_end timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  vendor_product_id character varying(255),
  wix_app_instance_id character varying(255)
);

CREATE TABLE client_activity_summary (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  summary_date date NOT NULL,
  events_received integer DEFAULT 0,
  grants_completed integer DEFAULT 0,
  revokes_completed integer DEFAULT 0,
  errors_count integer DEFAULT 0,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE clients (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  name character varying(255) NOT NULL,
  status character varying(50) DEFAULT 'active'::character varying,
  source_site_id character varying(255),
  notification_email character varying(255),
  last_sync_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  platform character varying(50) DEFAULT 'wix'::character varying NOT NULL,
  source_site_name character varying(255),
  source_site_url character varying(255),
  last_webhook_at timestamp with time zone,
  first_grant_sent boolean DEFAULT false NOT NULL,
  archived_at timestamp with time zone,
  source_api_key text,
  platform_instance_id character varying(255),
  reconciliation_interval character varying(20) DEFAULT 'daily'::character varying,
  last_active_member_count integer,
  wix_webhook_secret text,
  email_logo_url text,
  email_primary_color character varying(7),
  email_secondary_color character varying(7),
  member_emails_enabled boolean DEFAULT false NOT NULL,
  auto_revoke_mode character varying(16) DEFAULT 'dry_run'::character varying NOT NULL,
  qr_guide_url text
);

CREATE TABLE config_alert_log (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid,
  alert_type character varying(100) NOT NULL,
  plan_mapping_id uuid,
  hardware_ref character varying(255),
  affected_member_count integer DEFAULT 0,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  trace_id character varying(36),
  actor_type character varying(20),
  actor_id character varying(64)
);

CREATE TABLE connector_subscriptions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  hardware_platform character varying(50) NOT NULL,
  hardware_api_key text,
  kisi_user_pattern character varying(20) DEFAULT 'invited'::character varying NOT NULL,
  status character varying(50) DEFAULT 'active'::character varying,
  key_last_verified timestamp with time zone,
  key_last_error text,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  key_first_failed_at timestamp with time zone,
  key_last_alerted_at timestamp with time zone
);

CREATE TABLE diagnostic_log (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  client_id uuid,
  service character varying(100) NOT NULL,
  level character varying(20) NOT NULL,
  error_code character varying(100) NOT NULL,
  message text NOT NULL,
  context jsonb DEFAULT '{}'::jsonb,
  resolved_at timestamp with time zone,
  trace_id text,
  actor_type character varying(20),
  actor_id character varying(64)
);

CREATE TABLE error_queue (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid,
  member_id uuid,
  event_type character varying(100),
  payload jsonb,
  error_reason text,
  retry_count integer DEFAULT 0,
  status character varying(50) DEFAULT 'failed'::character varying,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  resolved_at timestamp with time zone,
  dismiss_note text,
  dismissed_by character varying(255),
  location_id uuid,
  plan_name character varying(255),
  door_name character varying(255),
  error_code text,
  user_message text,
  resolution text,
  action_text text,
  http_status integer,
  raw_api_body jsonb,
  occurred_count integer DEFAULT 1,
  last_occurred_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  trace_id character varying(36),
  actor_type character varying(20),
  actor_id character varying(64)
);

CREATE TABLE locations (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  name character varying(255) NOT NULL,
  city character varying(100),
  state character varying(50),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  notification_email character varying(255)
);

CREATE TABLE member_access (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  member_master_id uuid NOT NULL,
  client_id uuid NOT NULL,
  hardware_platform character varying(50),
  hardware_user_id character varying(255),
  source_platform character varying(50),
  platform_member_id character varying(255),
  status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
  provisioned_at timestamp with time zone,
  sub_master_id uuid,
  plan_holder boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  kisi_user_disappeared_observed_at timestamp with time zone
);

CREATE TABLE member_access_log (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  member_id uuid NOT NULL,
  client_id uuid NOT NULL,
  event_type character varying(100) NOT NULL,
  credential_type character varying(50),
  credential_value text,
  error_code character varying(50),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  trace_id character varying(36),
  actor_type character varying(20),
  actor_id character varying(64),
  mapping_id uuid,
  hardware_group_id character varying(64)
);

CREATE TABLE member_access_sources (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  access_id uuid NOT NULL,
  billing_id uuid,
  source_type character varying(50),
  source_plan_id character varying(255),
  hardware_group_id character varying(255),
  role_assignment_id character varying(255),
  mapping_id uuid,
  effective_start timestamp with time zone,
  valid_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  status character varying(50) DEFAULT 'active'::character varying NOT NULL,
  provisioned_at timestamp with time zone,
  scheduled_start_date timestamp with time zone,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  client_id uuid NOT NULL,
  retry_count integer DEFAULT 0 NOT NULL,
  last_retry_at timestamp with time zone,
  failure_reason text,
  not_paying_since timestamp with time zone,
  not_paying_last_seen_at timestamp with time zone,
  not_paying_observations integer DEFAULT 0 NOT NULL
);

CREATE TABLE member_billing (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  member_master_id uuid NOT NULL,
  client_id uuid NOT NULL,
  wix_order_id character varying(255) NOT NULL,
  wix_subscription_id character varying(255),
  cycle_index integer DEFAULT 1 NOT NULL,
  plan_id character varying(255),
  plan_name character varying(255),
  effective_start timestamp with time zone,
  effective_end timestamp with time zone,
  status character varying(50) DEFAULT 'active'::character varying NOT NULL,
  billing_snapshot jsonb,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  holder_seated boolean DEFAULT true NOT NULL
);

CREATE TABLE member_email_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  client_id uuid NOT NULL,
  member_master_id uuid,
  email_type character varying(40) NOT NULL,
  dedup_key text NOT NULL,
  recipient text,
  resend_id text,
  delivery_status character varying(20) DEFAULT 'sent'::character varying NOT NULL,
  trace_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE member_master (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  source_platform character varying(50) NOT NULL,
  platform_member_id character varying(255) NOT NULL,
  email character varying(255),
  first_name character varying(255),
  last_name character varying(255),
  display_name character varying(255),
  phone character varying(50),
  source_tag character varying(50) DEFAULT 'accesssync'::character varying,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operator_setup_state (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  client_id uuid NOT NULL,
  snippet_id text NOT NULL,
  install_state text DEFAULT 'not_installed'::text NOT NULL,
  version_installed text,
  last_telemetry_at timestamp with time zone,
  last_telemetry_version text,
  last_verified_at timestamp with time zone,
  last_test_at timestamp with time zone,
  last_test_result text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE plan_mapping_groups (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  mapping_id uuid NOT NULL,
  hardware_group_id character varying(255) NOT NULL,
  door_name character varying(255),
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  health_status character varying(20) DEFAULT 'ok'::character varying
);

CREATE TABLE plan_mappings (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  client_id uuid NOT NULL,
  source_plan_id character varying(255) NOT NULL,
  hardware_group_id character varying(255),
  tier_name character varying(50) DEFAULT 'Base'::character varying,
  action character varying(50) DEFAULT 'grant'::character varying,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  location_id uuid,
  plan_name character varying(255),
  door_name character varying(255),
  status character varying(50) DEFAULT 'active'::character varying,
  access_type character varying(50) DEFAULT 'group'::character varying,
  allow_multiple boolean DEFAULT false,
  max_members integer DEFAULT 1,
  source_status character varying(20) DEFAULT 'active'::character varying,
  day_pass_hours integer
);

CREATE TABLE processed_event_ids (
  event_id character varying(255) NOT NULL,
  client_id uuid,
  processed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reconciliation_proposal (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  run_id uuid,
  client_id uuid NOT NULL,
  platform_member_id character varying,
  source_plan_id character varying,
  hardware_group_id character varying,
  kind character varying(32) NOT NULL,
  source character varying(32),
  data_source character varying(32),
  classification character varying(16),
  decision character varying(16) NOT NULL,
  hold_reason character varying(48),
  evidence jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE reconciliation_run (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  client_id uuid NOT NULL,
  trace_id character varying(64),
  triggered_by character varying(32) NOT NULL,
  triggered_by_actor_type character varying(32),
  triggered_by_actor_id character varying(128),
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  status character varying(32) DEFAULT 'running'::character varying NOT NULL,
  abort_reason character varying(64),
  wix_active_count integer,
  kisi_managed_count integer,
  grants_queued integer DEFAULT 0 NOT NULL,
  revokes_queued integer DEFAULT 0 NOT NULL,
  grants_skipped_optin integer DEFAULT 0 NOT NULL,
  sanity_gate_triggered boolean DEFAULT false NOT NULL,
  sanity_gate_resolved boolean,
  notes text
);

CREATE TABLE trace_context (
  trace_id character varying(36) NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  client_id uuid,
  client_name character varying(255),
  member_id uuid,
  member_name character varying(255),
  member_email character varying(255),
  platform_member_id character varying(255),
  source_platform character varying(50),
  hardware_platform character varying(50),
  hardware_user_id character varying(64),
  plan_name character varying(255),
  door_name character varying(255),
  mapping_id uuid,
  actor_type character varying(20),
  actor_id character varying(64),
  entry_point character varying(50)
);

CREATE TABLE webhook_log (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  event_id character varying(255),
  client_id uuid,
  received_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  hmac_status character varying(20) NOT NULL,
  dedup_status character varying(20),
  event_type character varying(100),
  raw_payload jsonb,
  normalized_payload jsonb,
  error_detail text,
  trace_id text,
  actor_type character varying(20),
  actor_id character varying(64)
);

CREATE TABLE wix_admin_seen (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  client_id uuid NOT NULL,
  wix_uid character varying(64) NOT NULL,
  permissions character varying(32),
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  seen_count integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Primary keys
ALTER TABLE activity_event ADD CONSTRAINT activity_event_pkey PRIMARY KEY (id);
ALTER TABLE adapter_admin_log ADD CONSTRAINT adapter_admin_log_pkey PRIMARY KEY (id);
ALTER TABLE as_client_subscriptions ADD CONSTRAINT as_client_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE as_subscription_terms ADD CONSTRAINT as_subscription_terms_pkey PRIMARY KEY (id);
ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE client_activity_summary ADD CONSTRAINT client_activity_summary_pkey PRIMARY KEY (id);
ALTER TABLE clients ADD CONSTRAINT clients_pkey PRIMARY KEY (id);
ALTER TABLE config_alert_log ADD CONSTRAINT config_alert_log_pkey PRIMARY KEY (id);
ALTER TABLE connector_subscriptions ADD CONSTRAINT connector_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE diagnostic_log ADD CONSTRAINT diagnostic_log_pkey PRIMARY KEY (id);
ALTER TABLE error_queue ADD CONSTRAINT error_queue_pkey PRIMARY KEY (id);
ALTER TABLE locations ADD CONSTRAINT locations_pkey PRIMARY KEY (id);
ALTER TABLE member_access ADD CONSTRAINT member_access_pkey PRIMARY KEY (id);
ALTER TABLE member_access_log ADD CONSTRAINT member_access_log_pkey PRIMARY KEY (id);
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_pkey PRIMARY KEY (id);
ALTER TABLE member_billing ADD CONSTRAINT member_billing_pkey PRIMARY KEY (id);
ALTER TABLE member_email_log ADD CONSTRAINT member_email_log_pkey PRIMARY KEY (id);
ALTER TABLE member_master ADD CONSTRAINT member_master_pkey PRIMARY KEY (id);
ALTER TABLE operator_setup_state ADD CONSTRAINT operator_setup_state_pkey PRIMARY KEY (id);
ALTER TABLE plan_mapping_groups ADD CONSTRAINT plan_mapping_groups_pkey PRIMARY KEY (id);
ALTER TABLE plan_mappings ADD CONSTRAINT plan_mappings_pkey PRIMARY KEY (id);
ALTER TABLE processed_event_ids ADD CONSTRAINT processed_event_ids_pkey PRIMARY KEY (event_id);
ALTER TABLE reconciliation_proposal ADD CONSTRAINT reconciliation_proposal_pkey PRIMARY KEY (id);
ALTER TABLE reconciliation_run ADD CONSTRAINT reconciliation_run_pkey PRIMARY KEY (id);
ALTER TABLE trace_context ADD CONSTRAINT trace_context_pkey PRIMARY KEY (trace_id);
ALTER TABLE webhook_log ADD CONSTRAINT webhook_log_pkey PRIMARY KEY (id);
ALTER TABLE wix_admin_seen ADD CONSTRAINT wix_admin_seen_pkey PRIMARY KEY (id);

-- Unique constraints
ALTER TABLE as_client_subscriptions ADD CONSTRAINT as_client_subscriptions_client_id_location_id_key UNIQUE (client_id, location_id);
ALTER TABLE as_subscription_terms ADD CONSTRAINT as_subscription_terms_name_key UNIQUE (name);
ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscriptions_client_location_unique UNIQUE (client_id, location_id);
ALTER TABLE client_activity_summary ADD CONSTRAINT client_activity_summary_client_id_summary_date_key UNIQUE (client_id, summary_date);
ALTER TABLE clients ADD CONSTRAINT clients_wix_site_id_key UNIQUE (source_site_id);
ALTER TABLE connector_subscriptions ADD CONSTRAINT connector_subscriptions_client_id_hardware_platform_key UNIQUE (client_id, hardware_platform);
ALTER TABLE member_access ADD CONSTRAINT member_access_member_master_id_client_id_key UNIQUE (member_master_id, client_id);
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_client_access_source_plan_group_key UNIQUE (client_id, access_id, source_type, source_plan_id, hardware_group_id);
ALTER TABLE member_billing ADD CONSTRAINT member_billing_client_wix_order_cycle_key UNIQUE (client_id, wix_order_id, cycle_index);
ALTER TABLE member_email_log ADD CONSTRAINT member_email_log_dedup UNIQUE (client_id, email_type, dedup_key);
ALTER TABLE member_master ADD CONSTRAINT member_master_client_id_source_platform_platform_member_id_key UNIQUE (client_id, source_platform, platform_member_id);
ALTER TABLE operator_setup_state ADD CONSTRAINT operator_setup_state_unique UNIQUE (client_id, snippet_id);
ALTER TABLE plan_mapping_groups ADD CONSTRAINT plan_mapping_groups_mapping_id_hardware_group_id_key UNIQUE (mapping_id, hardware_group_id);
ALTER TABLE wix_admin_seen ADD CONSTRAINT wix_admin_seen_client_id_wix_uid_key UNIQUE (client_id, wix_uid);

-- Check constraints
ALTER TABLE clients ADD CONSTRAINT clients_auto_revoke_mode_check CHECK (((auto_revoke_mode)::text = ANY ((ARRAY['off'::character varying, 'dry_run'::character varying, 'on'::character varying])::text[])));
ALTER TABLE connector_subscriptions ADD CONSTRAINT connector_subscriptions_kisi_user_pattern_check CHECK (((kisi_user_pattern)::text = ANY (ARRAY[('invited'::character varying)::text, ('managed'::character varying)::text])));
ALTER TABLE diagnostic_log ADD CONSTRAINT diagnostic_log_level_check CHECK (((level)::text = ANY ((ARRAY['info'::character varying, 'warn'::character varying, 'error'::character varying, 'critical'::character varying])::text[])));
ALTER TABLE member_access ADD CONSTRAINT member_access_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'in_flight'::character varying, 'pending_identity'::character varying, 'recovery_pending'::character varying, 'removing'::character varying, 'deleted'::character varying])::text[])));
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('pending_hardware'::character varying)::text, ('pending_start'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text, ('revoked'::character varying)::text])));
ALTER TABLE operator_setup_state ADD CONSTRAINT operator_setup_state_install_state_check CHECK ((install_state = ANY (ARRAY['not_installed'::text, 'installed_unverified'::text, 'verified'::text, 'stale'::text, 'broken'::text])));

-- Foreign keys
ALTER TABLE adapter_admin_log ADD CONSTRAINT adapter_admin_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE as_client_subscriptions ADD CONSTRAINT as_client_subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE as_client_subscriptions ADD CONSTRAINT as_client_subscriptions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE as_client_subscriptions ADD CONSTRAINT as_client_subscriptions_term_id_fkey FOREIGN KEY (term_id) REFERENCES as_subscription_terms(id) ON DELETE SET NULL;
ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE billing_subscriptions ADD CONSTRAINT billing_subscriptions_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE client_activity_summary ADD CONSTRAINT client_activity_summary_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE config_alert_log ADD CONSTRAINT config_alert_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE config_alert_log ADD CONSTRAINT config_alert_log_plan_mapping_id_fkey FOREIGN KEY (plan_mapping_id) REFERENCES plan_mappings(id);
ALTER TABLE connector_subscriptions ADD CONSTRAINT connector_subscriptions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE diagnostic_log ADD CONSTRAINT diagnostic_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE error_queue ADD CONSTRAINT error_queue_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE error_queue ADD CONSTRAINT error_queue_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
ALTER TABLE locations ADD CONSTRAINT locations_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_access ADD CONSTRAINT member_access_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_access ADD CONSTRAINT member_access_member_master_id_fkey FOREIGN KEY (member_master_id) REFERENCES member_master(id) ON DELETE CASCADE;
ALTER TABLE member_access ADD CONSTRAINT member_access_sub_master_id_fkey FOREIGN KEY (sub_master_id) REFERENCES member_master(id);
ALTER TABLE member_access_log ADD CONSTRAINT member_access_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_access_id_fkey FOREIGN KEY (access_id) REFERENCES member_access(id) ON DELETE CASCADE;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_billing_id_fkey FOREIGN KEY (billing_id) REFERENCES member_billing(id) ON DELETE SET NULL;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_mapping_id_fkey FOREIGN KEY (mapping_id) REFERENCES plan_mappings(id) ON DELETE SET NULL;
ALTER TABLE member_billing ADD CONSTRAINT member_billing_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_billing ADD CONSTRAINT member_billing_member_master_id_fkey FOREIGN KEY (member_master_id) REFERENCES member_master(id) ON DELETE CASCADE;
ALTER TABLE member_email_log ADD CONSTRAINT member_email_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE member_email_log ADD CONSTRAINT member_email_log_member_master_id_fkey FOREIGN KEY (member_master_id) REFERENCES member_master(id) ON DELETE SET NULL;
ALTER TABLE member_master ADD CONSTRAINT member_master_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE operator_setup_state ADD CONSTRAINT operator_setup_state_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE plan_mapping_groups ADD CONSTRAINT plan_mapping_groups_mapping_id_fkey FOREIGN KEY (mapping_id) REFERENCES plan_mappings(id) ON DELETE CASCADE;
ALTER TABLE plan_mappings ADD CONSTRAINT plan_mappings_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE plan_mappings ADD CONSTRAINT plan_mappings_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id);
ALTER TABLE processed_event_ids ADD CONSTRAINT processed_event_ids_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE reconciliation_proposal ADD CONSTRAINT reconciliation_proposal_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE reconciliation_proposal ADD CONSTRAINT reconciliation_proposal_run_id_fkey FOREIGN KEY (run_id) REFERENCES reconciliation_run(id) ON DELETE CASCADE;
ALTER TABLE reconciliation_run ADD CONSTRAINT reconciliation_run_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE trace_context ADD CONSTRAINT trace_context_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE webhook_log ADD CONSTRAINT webhook_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
ALTER TABLE wix_admin_seen ADD CONSTRAINT wix_admin_seen_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

-- Indexes (the partial unique ones change behaviour; the rest are kept so plans match)
CREATE UNIQUE INDEX clients_platform_instance_id_idx ON public.clients USING btree (platform_instance_id) WHERE (platform_instance_id IS NOT NULL);
CREATE UNIQUE INDEX member_billing_one_active_per_subscription ON public.member_billing USING btree (client_id, member_master_id, wix_subscription_id) WHERE (((status)::text = 'active'::text) AND (wix_subscription_id IS NOT NULL));
CREATE INDEX idx_member_access_client_status ON public.member_access USING btree (client_id, status);
CREATE INDEX idx_member_access_sub_master ON public.member_access USING btree (sub_master_id) WHERE (sub_master_id IS NOT NULL);
CREATE INDEX idx_member_access_sources_access ON public.member_access_sources USING btree (access_id);
CREATE INDEX idx_member_access_sources_billing ON public.member_access_sources USING btree (billing_id) WHERE (billing_id IS NOT NULL);
CREATE INDEX idx_member_billing_master_status ON public.member_billing USING btree (member_master_id, status);
CREATE INDEX idx_member_billing_wix_order ON public.member_billing USING btree (wix_order_id);
CREATE INDEX idx_member_master_client_platform ON public.member_master USING btree (client_id, source_platform, platform_member_id);
CREATE INDEX idx_diagnostic_log_trace_id ON public.diagnostic_log USING btree (trace_id) WHERE (trace_id IS NOT NULL);
CREATE INDEX idx_error_queue_dedup ON public.error_queue USING btree (client_id, member_id, error_code) WHERE ((status)::text = 'failed'::text);
