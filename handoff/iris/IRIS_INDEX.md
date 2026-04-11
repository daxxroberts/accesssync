---
file: IRIS_INDEX.md
produced_by: IRIS
step: 3 of 9
handoff_version: 1.0.0
date: 2026-04-10
---

# IRIS Screen Map Index — AccessSync

All screens across both servers. Each screen has its own IRIS map file.

---

## Operator Portal (admin/server.js — Wix Dashboard iframe)

| ID | Screen | File | Route | Status |
|----|--------|------|-------|--------|
| S01 | Portal Setup Welcome | IRIS_S01_portal_setup.md | /operator-portal/setup | Built |
| S02 | Onboarding Flow | IRIS_S02_onboard.md | /onboard | Built |
| S03 | Dashboard Overview | IRIS_S03_dashboard.md | /dashboard | Built |
| S04 | System Config | IRIS_S04_system_config.md | /system-config | Built (within onboard/dashboard) |
| S05 | Locations | IRIS_S05_locations.md | /locations | Built |
| S06 | Plan Mapping | IRIS_S06_plan_mapping.md | /plan-mapping | Built |
| S07 | Members | IRIS_S07_members.md | /members | Built (mock data) |
| S08 | Access Log | IRIS_S08_access.md | /access | Built |
| S09 | Sync Status | IRIS_S09_sync_status.md | /sync-status | Built |
| S10 | Error Queue (Operator) | IRIS_S10_error_queue_operator.md | within sync-status / dashboard | Built |
| S11 | Admin Panel | IRIS_S11_admin_panel.md | /admin-panel | Built (mock data) |
| S12 | Multi-Member Editor | IRIS_S12_multi_member.md | /multi-member | Built, GATED (deferred post-HOG) |

## Member-Facing (Core Engine — core/server.js)

| ID | Screen | File | Route | Status |
|----|--------|------|-------|--------|
| S13 | Sync Status Widget | IRIS_S13_sync_status_member.md | /sync-status?memberId=X&clientId=Y | Built |

## Admin Hub (admin/server.js — Daxx-only)

| ID | Screen | File | Route | Status |
|----|--------|------|-------|--------|
| S14 | Admin Hub Login | IRIS_S14_admin_login.md | /admin/login | Built |
| S15 | Admin Hub Dashboard | IRIS_S15_admin_hub.md | /admin/dashboard (index.html tabs) | Built |

## Entry Points

| ID | Screen | Notes |
|----|--------|-------|
| S16 | Wix Dashboard Sidebar Entry | /operator-portal?instance= → S01 or S03 |

---

*16 screens total. 12 operator portal, 1 member widget, 2 admin hub, 1 entry flow.*
