# Graph Report - .  (2026-04-10)

## Corpus Check
- 53 files · ~70,588 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 262 nodes · 370 edges · 49 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `apiFetch()` - 26 edges
2. `toast()` - 14 edges
3. `HardwareAdapter` - 11 edges
4. `KisiAdapter` - 10 edges
5. `SeamAdapter` - 9 edges
6. `loadClients()` - 9 edges
7. `StandardAdapter` - 8 edges
8. `NightlyReconciliation` - 8 edges
9. `WebhookProcessor` - 7 edges
10. `esc()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `openErrorDetail()` --calls--> `apiFetch()`  [EXTRACTED]
  admin\public\app.js → admin\public\app.js  _Bridges community 0 → community 1_

## Communities

### Community 0 - "Community 0"
Cohesion: 0.1
Nodes (47): apiFetch(), archiveClient(), closeDrawer(), deleteClient(), dismissError(), doMemberSearch(), filterClients(), handleGoogleCredential() (+39 more)

### Community 1 - "Community 1"
Cohesion: 0.26
Nodes (13): esc(), fmt(), openApiKeyForm(), openDrawer(), openErrorDetail(), openMemberTimeline(), openWebhookDetail(), pill() (+5 more)

### Community 2 - "Community 2"
Cohesion: 0.29
Nodes (1): HardwareAdapter

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (1): KisiAdapter

### Community 4 - "Community 4"
Cohesion: 0.22
Nodes (3): apiFetch(), showSessionExpiredModal(), stopAllPolling()

### Community 5 - "Community 5"
Cohesion: 0.2
Nodes (1): SeamAdapter

### Community 6 - "Community 6"
Cohesion: 0.36
Nodes (1): StandardAdapter

### Community 7 - "Community 7"
Cohesion: 0.36
Nodes (1): NightlyReconciliation

### Community 8 - "Community 8"
Cohesion: 0.43
Nodes (1): WebhookProcessor

### Community 9 - "Community 9"
Cohesion: 0.39
Nodes (3): BusinessRiskReporter, formatDivider(), getTierForPath()

### Community 10 - "Community 10"
Cohesion: 0.29
Nodes (0): 

### Community 11 - "Community 11"
Cohesion: 0.29
Nodes (1): TenantResolver

### Community 12 - "Community 12"
Cohesion: 0.47
Nodes (1): KisiConnector

### Community 13 - "Community 13"
Cohesion: 0.67
Nodes (5): listAllMappable(), listBookingServices(), listPricingPlans(), testApiKey(), wixFetch()

### Community 14 - "Community 14"
Cohesion: 0.6
Nodes (5): _checkLocation(), _diagnose(), _notifyFailure(), runHealthCheck(), _updateLocationVerification()

### Community 15 - "Community 15"
Cohesion: 0.53
Nodes (1): MemberSyncApi

### Community 16 - "Community 16"
Cohesion: 0.47
Nodes (1): RetryEngine

### Community 17 - "Community 17"
Cohesion: 0.4
Nodes (1): SeamConnector

### Community 18 - "Community 18"
Cohesion: 0.5
Nodes (1): WixConnector

### Community 19 - "Community 19"
Cohesion: 0.5
Nodes (1): GrantRevokeLogic

### Community 20 - "Community 20"
Cohesion: 0.67
Nodes (2): healthCheck(), query()

### Community 21 - "Community 21"
Cohesion: 0.83
Nodes (3): extractSiteIdFromAuthCode(), requireWixInstance(), verifySignedInstance()

### Community 22 - "Community 22"
Cohesion: 0.83
Nodes (3): decryptApiKey(), encryptApiKey(), _getKey()

### Community 23 - "Community 23"
Cohesion: 0.67
Nodes (2): getClientApiKey(), processJob()

### Community 24 - "Community 24"
Cohesion: 0.5
Nodes (1): PrioritySequencer

### Community 25 - "Community 25"
Cohesion: 0.67
Nodes (0): 

### Community 26 - "Community 26"
Cohesion: 0.67
Nodes (1): WixAdapter

### Community 27 - "Community 27"
Cohesion: 0.67
Nodes (0): 

### Community 28 - "Community 28"
Cohesion: 1.0
Nodes (2): recordFailure(), _sendAlert()

### Community 29 - "Community 29"
Cohesion: 1.0
Nodes (2): _setLocationStatus(), suspendLocationMembers()

### Community 30 - "Community 30"
Cohesion: 0.67
Nodes (1): PlanMappingResolver

### Community 31 - "Community 31"
Cohesion: 1.0
Nodes (2): getRedisConnection(), parseRedisUrl()

### Community 32 - "Community 32"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Community 33"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "Community 34"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "Community 35"
Cohesion: 1.0
Nodes (0): 

### Community 36 - "Community 36"
Cohesion: 1.0
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

## Knowledge Gaps
- **Thin community `Community 32`** (2 nodes): `seed.js`, `seed()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 33`** (2 nodes): `simulate.js`, `runSimulation()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (2 nodes): `audit.js`, `logAdminAction()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 35`** (2 nodes): `member-cancels-loses-access.test.js`, `mockClientApiKey()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (1 nodes): `jest.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (1 nodes): `test-screens.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (1 nodes): `clients.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 39`** (1 nodes): `errors.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 40`** (1 nodes): `members.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (1 nodes): `multi-member.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (1 nodes): `portal.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (1 nodes): `queue.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (1 nodes): `webhooks.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (1 nodes): `fixtures.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (1 nodes): `member-pays-gets-access.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (1 nodes): `api-key-encryption.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (1 nodes): `wix-adapter-parsing.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `apiFetch()` connect `Community 0` to `Community 1`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._