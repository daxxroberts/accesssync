# Graph Report - .  (2026-04-18)

## Corpus Check
- 70 files · ~91,628 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 296 nodes · 337 edges · 65 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `HardwareAdapter` - 14 edges
2. `StandardAdapter` - 11 edges
3. `KisiAdapter` - 11 edges
4. `SeamAdapter` - 10 edges
5. `NightlyReconciliation` - 10 edges
6. `_checkLocation()` - 7 edges
7. `TenantResolver` - 7 edges
8. `WebhookProcessor` - 7 edges
9. `wixFetch()` - 6 edges
10. `switchPanel()` - 6 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (16): apiFetch(), hideLoginError(), initDashboard(), initGoogleSignIn(), initMemberSync(), loadClients(), loadErrors(), showDashboard() (+8 more)

### Community 1 - "Community 1"
Cohesion: 0.28
Nodes (2): HardwareAdapter, _requireFields()

### Community 2 - "Community 2"
Cohesion: 0.19
Nodes (5): activateJumpTarget(), apiFetch(), esc(), showSessionExpiredModal(), stopAllPolling()

### Community 3 - "Community 3"
Cohesion: 0.29
Nodes (1): StandardAdapter

### Community 4 - "Community 4"
Cohesion: 0.17
Nodes (1): KisiAdapter

### Community 5 - "Community 5"
Cohesion: 0.18
Nodes (1): SeamAdapter

### Community 6 - "Community 6"
Cohesion: 0.31
Nodes (1): NightlyReconciliation

### Community 7 - "Community 7"
Cohesion: 0.38
Nodes (9): _checkLocation(), _diagnose(), _notifyArchivedPlans(), _notifyFailure(), _notifyOrphanedGroups(), _reconcileGroups(), _reconcileWixPlans(), runHealthCheck() (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.5
Nodes (7): listActiveOrders(), listAllMappable(), listBookingServices(), listConfirmedBookings(), listPricingPlans(), testApiKey(), wixFetch()

### Community 9 - "Community 9"
Cohesion: 0.25
Nodes (1): TenantResolver

### Community 10 - "Community 10"
Cohesion: 0.43
Nodes (1): WebhookProcessor

### Community 11 - "Community 11"
Cohesion: 0.39
Nodes (3): BusinessRiskReporter, formatDivider(), getTierForPath()

### Community 12 - "Community 12"
Cohesion: 0.52
Nodes (5): _collectContactEmails(), _extractName(), _getContactById(), getMemberById(), wixFetch()

### Community 13 - "Community 13"
Cohesion: 0.29
Nodes (0): 

### Community 14 - "Community 14"
Cohesion: 0.38
Nodes (3): activateLocationMembers(), resolveApiKey(), syncMappingMembers()

### Community 15 - "Community 15"
Cohesion: 0.47
Nodes (1): KisiConnector

### Community 16 - "Community 16"
Cohesion: 0.4
Nodes (2): emit(), persistToDiagnosticLog()

### Community 17 - "Community 17"
Cohesion: 0.53
Nodes (1): MemberSyncApi

### Community 18 - "Community 18"
Cohesion: 0.47
Nodes (1): RetryEngine

### Community 19 - "Community 19"
Cohesion: 0.7
Nodes (3): getLog(), healthCheck(), query()

### Community 20 - "Community 20"
Cohesion: 0.4
Nodes (1): SeamConnector

### Community 21 - "Community 21"
Cohesion: 0.5
Nodes (1): WixConnector

### Community 22 - "Community 22"
Cohesion: 0.5
Nodes (1): GrantRevokeLogic

### Community 23 - "Community 23"
Cohesion: 0.4
Nodes (1): RateLimiter

### Community 24 - "Community 24"
Cohesion: 0.4
Nodes (0): 

### Community 25 - "Community 25"
Cohesion: 0.67
Nodes (1): WixAdapter

### Community 26 - "Community 26"
Cohesion: 0.83
Nodes (3): extractSiteIdFromAuthCode(), requireWixInstance(), verifySignedInstance()

### Community 27 - "Community 27"
Cohesion: 0.83
Nodes (3): decryptApiKey(), encryptApiKey(), _getKey()

### Community 28 - "Community 28"
Cohesion: 0.67
Nodes (2): getClientApiKey(), processJob()

### Community 29 - "Community 29"
Cohesion: 0.5
Nodes (1): PrioritySequencer

### Community 30 - "Community 30"
Cohesion: 0.67
Nodes (0): 

### Community 31 - "Community 31"
Cohesion: 1.0
Nodes (2): recordFailure(), _sendAlert()

### Community 32 - "Community 32"
Cohesion: 1.0
Nodes (2): _setLocationStatus(), suspendLocationMembers()

### Community 33 - "Community 33"
Cohesion: 0.67
Nodes (1): PlanMappingResolver

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (2): getRedisConnection(), parseRedisUrl()

### Community 35 - "Community 35"
Cohesion: 0.67
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 0.67
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "Community 38"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Community 40"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Community 41"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Community 42"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Community 43"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (0): 

### Community 46 - "Community 46"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Community 47"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 1.0
Nodes (0): 

### Community 51 - "Community 51"
Cohesion: 1.0
Nodes (0): 

### Community 52 - "Community 52"
Cohesion: 1.0
Nodes (0): 

### Community 53 - "Community 53"
Cohesion: 1.0
Nodes (0): 

### Community 54 - "Community 54"
Cohesion: 1.0
Nodes (0): 

### Community 55 - "Community 55"
Cohesion: 1.0
Nodes (0): 

### Community 56 - "Community 56"
Cohesion: 1.0
Nodes (0): 

### Community 57 - "Community 57"
Cohesion: 1.0
Nodes (0): 

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (0): 

### Community 59 - "Community 59"
Cohesion: 1.0
Nodes (0): 

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (0): 

### Community 61 - "Community 61"
Cohesion: 1.0
Nodes (0): 

### Community 62 - "Community 62"
Cohesion: 1.0
Nodes (0): 

### Community 63 - "Community 63"
Cohesion: 1.0
Nodes (0): 

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Community 37`** (2 nodes): `seed.js`, `seed()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (2 nodes): `simulate.js`, `runSimulation()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (2 nodes): `audit.js`, `logAdminAction()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (2 nodes): `clients.js`, `activateLocationMembersAdmin()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (2 nodes): `toast.js`, `showToast()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (2 nodes): `audit-by-internal-id.js`, `section()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (2 nodes): `audit-kisi.js`, `header()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (2 nodes): `audit-member.js`, `section()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (2 nodes): `member-cancels-loses-access.test.js`, `mockClientApiKey()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (2 nodes): `plan-mapping-resolver.test.js`, `mockMappingRow()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `jest.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `test-screens.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 49`** (1 nodes): `errors.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (1 nodes): `members.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 51`** (1 nodes): `multi-member.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 52`** (1 nodes): `portal.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 53`** (1 nodes): `queue.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (1 nodes): `webhooks.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (1 nodes): `main.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (1 nodes): `plan-mapping-entry.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 57`** (1 nodes): `audit-summary.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (1 nodes): `fixtures.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 59`** (1 nodes): `grant-retry-idempotency.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (1 nodes): `member-pays-gets-access.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 61`** (1 nodes): `ob-89-two-gate.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 62`** (1 nodes): `api-key-encryption.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 63`** (1 nodes): `rate-limiter.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (1 nodes): `wix-adapter-parsing.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._