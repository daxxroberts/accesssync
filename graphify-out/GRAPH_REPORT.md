# Graph Report - .  (2026-07-02)

## Corpus Check
- 197 files · ~261,814 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 758 nodes · 836 edges · 188 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `StandardAdapter` - 16 edges
2. `HardwareAdapter` - 15 edges
3. `buildTraceBundle()` - 14 edges
4. `KisiAdapter` - 13 edges
5. `NightlyReconciliation` - 13 edges
6. `buildMemberBundle()` - 13 edges
7. `SeamAdapter` - 10 edges
8. `_send()` - 10 edges
9. `render()` - 8 edges
10. `main()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `query()` --calls--> `getLog()`  [EXTRACTED]
  e2e\helpers\db.js → db.js
- `healthCheck()` --calls--> `query()`  [EXTRACTED]
  db.js → e2e\helpers\db.js

## Communities

### Community 0 - "Community 0"
Cohesion: 0.14
Nodes (16): apiFetch(), hideLoginError(), initDashboard(), initGoogleSignIn(), initMemberSync(), loadClients(), loadErrors(), showDashboard() (+8 more)

### Community 1 - "Community 1"
Cohesion: 0.17
Nodes (19): close(), endpointBase(), esc(), escListener(), fetchAll(), fmtClock(), injectMarkup(), injectStyles() (+11 more)

### Community 2 - "Community 2"
Cohesion: 0.24
Nodes (19): buildMemberBundle(), buildTraceBundle(), extractInstructionBody(), filterEventRegistry(), filterLayerMap(), fullDrLedger(), loadMemberSnapshot(), loadMemberTraces() (+11 more)

### Community 3 - "Community 3"
Cohesion: 0.26
Nodes (2): HardwareAdapter, _requireFields()

### Community 4 - "Community 4"
Cohesion: 0.19
Nodes (1): StandardAdapter

### Community 5 - "Community 5"
Cohesion: 0.16
Nodes (4): buildAccessSyncMarker(), findElevatedAssignments(), KisiAdapter, parseAccessSyncMarker()

### Community 6 - "Community 6"
Cohesion: 0.3
Nodes (15): attachErrors(), buildMembersArray(), deriveExpiresLabel(), fetchJSON(), formatCouponLine(), formatDate(), formatRate(), loadMembers() (+7 more)

### Community 7 - "Community 7"
Cohesion: 0.19
Nodes (6): App(), Drawer(), fmtClock(), fmtRel(), getVoiceCookie(), Row()

### Community 8 - "Community 8"
Cohesion: 0.18
Nodes (5): activateJumpTarget(), apiFetch(), esc(), showSessionExpiredModal(), stopAllPolling()

### Community 9 - "Community 9"
Cohesion: 0.22
Nodes (1): NightlyReconciliation

### Community 10 - "Community 10"
Cohesion: 0.19
Nodes (6): buildWebhookHeaders(), buildWebhookSignature(), getAdminCookie(), getWixWebhookSecret(), postWebhook(), setAdminCookieOnContext()

### Community 11 - "Community 11"
Cohesion: 0.23
Nodes (6): buildOrderCancelledPayload(), buildOrderPausedPayload(), buildOrderPurchasedPayload(), buildOrderStartedPayload(), makeE2eEmail(), makeWixMemberId()

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (0): 

### Community 13 - "Community 13"
Cohesion: 0.28
Nodes (12): buildTimeline(), checkSetup(), fetchRailwayLogs(), humanize(), listRecentTraces(), loadEventRegistry(), main(), queryDb() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (2): resolveActor(), traceContextMiddleware()

### Community 15 - "Community 15"
Cohesion: 0.18
Nodes (1): SeamAdapter

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (3): ActionsMenu(), ErrorPopover(), useClickOutside()

### Community 17 - "Community 17"
Cohesion: 0.33
Nodes (9): _checkLocation(), _diagnose(), _notifyArchivedPlans(), _notifyFailure(), _notifyOrphanedGroups(), _reconcileGroups(), _reconcileWixPlans(), _runHealthCheckBody() (+1 more)

### Community 18 - "Community 18"
Cohesion: 0.35
Nodes (10): _send(), wixBookings_onBookingCanceled(), wixBookings_onBookingConfirmed(), wixMembers_onMemberDeleted(), wixPricingPlans_onOrderAutoRenewCanceled(), wixPricingPlans_onOrderCanceled(), wixPricingPlans_onOrderEnded(), wixPricingPlans_onOrderPurchased() (+2 more)

### Community 19 - "Community 19"
Cohesion: 0.42
Nodes (7): listActiveOrders(), listAllMappable(), listBookingServices(), listConfirmedBookings(), listPricingPlans(), testApiKey(), wixFetch()

### Community 20 - "Community 20"
Cohesion: 0.36
Nodes (5): getLog(), healthCheck(), query(), queryOne(), queryRows()

### Community 21 - "Community 21"
Cohesion: 0.47
Nodes (7): dumpConstraints(), dumpExtensions(), dumpIndexes(), dumpTable(), dumpViews(), QUOTE(), section()

### Community 22 - "Community 22"
Cohesion: 0.39
Nodes (3): BusinessRiskReporter, formatDivider(), getTierForPath()

### Community 23 - "Community 23"
Cohesion: 0.32
Nodes (3): activateLocationMembers(), resolveApiKey(), syncMappingMembers()

### Community 24 - "Community 24"
Cohesion: 0.25
Nodes (1): TenantResolver

### Community 25 - "Community 25"
Cohesion: 0.43
Nodes (1): WebhookProcessor

### Community 26 - "Community 26"
Cohesion: 0.43
Nodes (1): WixConnector

### Community 27 - "Community 27"
Cohesion: 0.52
Nodes (5): _collectContactEmails(), _extractName(), _getContactById(), getMemberById(), wixFetch()

### Community 28 - "Community 28"
Cohesion: 0.48
Nodes (5): getRegistry(), getSnippet(), listSnippets(), renderSnippet(), validateEnv()

### Community 29 - "Community 29"
Cohesion: 0.43
Nodes (4): addSubMember(), postWebhook(), provisionCouplesWithSub(), waitFor()

### Community 30 - "Community 30"
Cohesion: 0.47
Nodes (1): KisiConnector

### Community 31 - "Community 31"
Cohesion: 0.53
Nodes (4): redact(), redactObject(), redactString(), redactValue()

### Community 32 - "Community 32"
Cohesion: 0.4
Nodes (2): emit(), persistToDiagnosticLog()

### Community 33 - "Community 33"
Cohesion: 0.53
Nodes (1): MemberSyncApi

### Community 34 - "Community 34"
Cohesion: 0.47
Nodes (1): RetryEngine

### Community 35 - "Community 35"
Cohesion: 0.53
Nodes (4): _recordFailure(), _recordSuccess(), _retryOne(), _runProbeBody()

### Community 36 - "Community 36"
Cohesion: 0.33
Nodes (0): 

### Community 37 - "Community 37"
Cohesion: 0.6
Nodes (5): buildMembersArray(), formatCouponLine(), formatRate(), shapeBilling(), shapeMemberMinimal()

### Community 38 - "Community 38"
Cohesion: 0.4
Nodes (0): 

### Community 39 - "Community 39"
Cohesion: 0.4
Nodes (1): SeamConnector

### Community 40 - "Community 40"
Cohesion: 0.7
Nodes (4): extractSiteIdFromAuthCode(), recordWixAdminSeen(), requireWixInstance(), verifySignedInstance()

### Community 41 - "Community 41"
Cohesion: 0.6
Nodes (3): describeSqlstate(), humanize(), isSqlstate()

### Community 42 - "Community 42"
Cohesion: 0.5
Nodes (1): GrantRevokeLogic

### Community 43 - "Community 43"
Cohesion: 0.5
Nodes (2): getClientApiKey(), _processJobBody()

### Community 44 - "Community 44"
Cohesion: 0.4
Nodes (1): RateLimiter

### Community 45 - "Community 45"
Cohesion: 0.5
Nodes (2): waitFor(), waitForActive()

### Community 46 - "Community 46"
Cohesion: 0.7
Nodes (4): grantAndActivate(), postWebhook(), waitFor(), waitForStatus()

### Community 47 - "Community 47"
Cohesion: 0.4
Nodes (0): 

### Community 48 - "Community 48"
Cohesion: 0.5
Nodes (2): dumpTable(), QUOTE_ID()

### Community 49 - "Community 49"
Cohesion: 0.4
Nodes (0): 

### Community 50 - "Community 50"
Cohesion: 0.67
Nodes (1): WixAdapter

### Community 51 - "Community 51"
Cohesion: 0.5
Nodes (0): 

### Community 52 - "Community 52"
Cohesion: 0.83
Nodes (3): decryptApiKey(), encryptApiKey(), _getKey()

### Community 53 - "Community 53"
Cohesion: 0.5
Nodes (0): 

### Community 54 - "Community 54"
Cohesion: 0.67
Nodes (2): waitFor(), waitForStatus()

### Community 55 - "Community 55"
Cohesion: 0.5
Nodes (0): 

### Community 56 - "Community 56"
Cohesion: 0.5
Nodes (0): 

### Community 57 - "Community 57"
Cohesion: 0.5
Nodes (0): 

### Community 58 - "Community 58"
Cohesion: 0.5
Nodes (0): 

### Community 59 - "Community 59"
Cohesion: 0.5
Nodes (0): 

### Community 60 - "Community 60"
Cohesion: 0.5
Nodes (0): 

### Community 61 - "Community 61"
Cohesion: 0.5
Nodes (1): PrioritySequencer

### Community 62 - "Community 62"
Cohesion: 0.5
Nodes (0): 

### Community 63 - "Community 63"
Cohesion: 0.5
Nodes (0): 

### Community 64 - "Community 64"
Cohesion: 0.67
Nodes (0): 

### Community 65 - "Community 65"
Cohesion: 0.67
Nodes (0): 

### Community 66 - "Community 66"
Cohesion: 0.67
Nodes (0): 

### Community 67 - "Community 67"
Cohesion: 0.67
Nodes (0): 

### Community 68 - "Community 68"
Cohesion: 0.67
Nodes (0): 

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (2): recordFailure(), _sendAlert()

### Community 70 - "Community 70"
Cohesion: 1.0
Nodes (2): _setLocationStatus(), suspendLocationMembers()

### Community 71 - "Community 71"
Cohesion: 0.67
Nodes (1): PlanMappingResolver

### Community 72 - "Community 72"
Cohesion: 1.0
Nodes (2): getRedisConnection(), parseRedisUrl()

### Community 73 - "Community 73"
Cohesion: 0.67
Nodes (0): 

### Community 74 - "Community 74"
Cohesion: 0.67
Nodes (0): 

### Community 75 - "Community 75"
Cohesion: 0.67
Nodes (0): 

### Community 76 - "Community 76"
Cohesion: 0.67
Nodes (0): 

### Community 77 - "Community 77"
Cohesion: 0.67
Nodes (0): 

### Community 78 - "Community 78"
Cohesion: 0.67
Nodes (0): 

### Community 79 - "Community 79"
Cohesion: 0.67
Nodes (0): 

### Community 80 - "Community 80"
Cohesion: 0.67
Nodes (0): 

### Community 81 - "Community 81"
Cohesion: 0.67
Nodes (0): 

### Community 82 - "Community 82"
Cohesion: 0.67
Nodes (0): 

### Community 83 - "Community 83"
Cohesion: 0.67
Nodes (0): 

### Community 84 - "Community 84"
Cohesion: 1.0
Nodes (2): kisiRequest(), main()

### Community 85 - "Community 85"
Cohesion: 0.67
Nodes (0): 

### Community 86 - "Community 86"
Cohesion: 0.67
Nodes (0): 

### Community 87 - "Community 87"
Cohesion: 0.67
Nodes (0): 

### Community 88 - "Community 88"
Cohesion: 0.67
Nodes (0): 

### Community 89 - "Community 89"
Cohesion: 0.67
Nodes (0): 

### Community 90 - "Community 90"
Cohesion: 0.67
Nodes (0): 

### Community 91 - "Community 91"
Cohesion: 0.67
Nodes (0): 

### Community 92 - "Community 92"
Cohesion: 0.67
Nodes (0): 

### Community 93 - "Community 93"
Cohesion: 0.67
Nodes (0): 

### Community 94 - "Community 94"
Cohesion: 0.67
Nodes (0): 

### Community 95 - "Community 95"
Cohesion: 0.67
Nodes (0): 

### Community 96 - "Community 96"
Cohesion: 1.0
Nodes (0): 

### Community 97 - "Community 97"
Cohesion: 1.0
Nodes (0): 

### Community 98 - "Community 98"
Cohesion: 1.0
Nodes (0): 

### Community 99 - "Community 99"
Cohesion: 1.0
Nodes (0): 

### Community 100 - "Community 100"
Cohesion: 1.0
Nodes (0): 

### Community 101 - "Community 101"
Cohesion: 1.0
Nodes (0): 

### Community 102 - "Community 102"
Cohesion: 1.0
Nodes (0): 

### Community 103 - "Community 103"
Cohesion: 1.0
Nodes (0): 

### Community 104 - "Community 104"
Cohesion: 1.0
Nodes (0): 

### Community 105 - "Community 105"
Cohesion: 1.0
Nodes (0): 

### Community 106 - "Community 106"
Cohesion: 1.0
Nodes (0): 

### Community 107 - "Community 107"
Cohesion: 1.0
Nodes (0): 

### Community 108 - "Community 108"
Cohesion: 1.0
Nodes (0): 

### Community 109 - "Community 109"
Cohesion: 1.0
Nodes (0): 

### Community 110 - "Community 110"
Cohesion: 1.0
Nodes (0): 

### Community 111 - "Community 111"
Cohesion: 1.0
Nodes (0): 

### Community 112 - "Community 112"
Cohesion: 1.0
Nodes (0): 

### Community 113 - "Community 113"
Cohesion: 1.0
Nodes (0): 

### Community 114 - "Community 114"
Cohesion: 1.0
Nodes (0): 

### Community 115 - "Community 115"
Cohesion: 1.0
Nodes (0): 

### Community 116 - "Community 116"
Cohesion: 1.0
Nodes (0): 

### Community 117 - "Community 117"
Cohesion: 1.0
Nodes (0): 

### Community 118 - "Community 118"
Cohesion: 1.0
Nodes (0): 

### Community 119 - "Community 119"
Cohesion: 1.0
Nodes (0): 

### Community 120 - "Community 120"
Cohesion: 1.0
Nodes (0): 

### Community 121 - "Community 121"
Cohesion: 1.0
Nodes (0): 

### Community 122 - "Community 122"
Cohesion: 1.0
Nodes (0): 

### Community 123 - "Community 123"
Cohesion: 1.0
Nodes (0): 

### Community 124 - "Community 124"
Cohesion: 1.0
Nodes (0): 

### Community 125 - "Community 125"
Cohesion: 1.0
Nodes (0): 

### Community 126 - "Community 126"
Cohesion: 1.0
Nodes (0): 

### Community 127 - "Community 127"
Cohesion: 1.0
Nodes (0): 

### Community 128 - "Community 128"
Cohesion: 1.0
Nodes (0): 

### Community 129 - "Community 129"
Cohesion: 1.0
Nodes (0): 

### Community 130 - "Community 130"
Cohesion: 1.0
Nodes (0): 

### Community 131 - "Community 131"
Cohesion: 1.0
Nodes (0): 

### Community 132 - "Community 132"
Cohesion: 1.0
Nodes (0): 

### Community 133 - "Community 133"
Cohesion: 1.0
Nodes (0): 

### Community 134 - "Community 134"
Cohesion: 1.0
Nodes (0): 

### Community 135 - "Community 135"
Cohesion: 1.0
Nodes (0): 

### Community 136 - "Community 136"
Cohesion: 1.0
Nodes (0): 

### Community 137 - "Community 137"
Cohesion: 1.0
Nodes (0): 

### Community 138 - "Community 138"
Cohesion: 1.0
Nodes (0): 

### Community 139 - "Community 139"
Cohesion: 1.0
Nodes (0): 

### Community 140 - "Community 140"
Cohesion: 1.0
Nodes (0): 

### Community 141 - "Community 141"
Cohesion: 1.0
Nodes (0): 

### Community 142 - "Community 142"
Cohesion: 1.0
Nodes (0): 

### Community 143 - "Community 143"
Cohesion: 1.0
Nodes (0): 

### Community 144 - "Community 144"
Cohesion: 1.0
Nodes (0): 

### Community 145 - "Community 145"
Cohesion: 1.0
Nodes (0): 

### Community 146 - "Community 146"
Cohesion: 1.0
Nodes (0): 

### Community 147 - "Community 147"
Cohesion: 1.0
Nodes (0): 

### Community 148 - "Community 148"
Cohesion: 1.0
Nodes (0): 

### Community 149 - "Community 149"
Cohesion: 1.0
Nodes (0): 

### Community 150 - "Community 150"
Cohesion: 1.0
Nodes (0): 

### Community 151 - "Community 151"
Cohesion: 1.0
Nodes (0): 

### Community 152 - "Community 152"
Cohesion: 1.0
Nodes (0): 

### Community 153 - "Community 153"
Cohesion: 1.0
Nodes (0): 

### Community 154 - "Community 154"
Cohesion: 1.0
Nodes (0): 

### Community 155 - "Community 155"
Cohesion: 1.0
Nodes (0): 

### Community 156 - "Community 156"
Cohesion: 1.0
Nodes (0): 

### Community 157 - "Community 157"
Cohesion: 1.0
Nodes (0): 

### Community 158 - "Community 158"
Cohesion: 1.0
Nodes (0): 

### Community 159 - "Community 159"
Cohesion: 1.0
Nodes (0): 

### Community 160 - "Community 160"
Cohesion: 1.0
Nodes (0): 

### Community 161 - "Community 161"
Cohesion: 1.0
Nodes (0): 

### Community 162 - "Community 162"
Cohesion: 1.0
Nodes (0): 

### Community 163 - "Community 163"
Cohesion: 1.0
Nodes (0): 

### Community 164 - "Community 164"
Cohesion: 1.0
Nodes (0): 

### Community 165 - "Community 165"
Cohesion: 1.0
Nodes (0): 

### Community 166 - "Community 166"
Cohesion: 1.0
Nodes (0): 

### Community 167 - "Community 167"
Cohesion: 1.0
Nodes (0): 

### Community 168 - "Community 168"
Cohesion: 1.0
Nodes (0): 

### Community 169 - "Community 169"
Cohesion: 1.0
Nodes (0): 

### Community 170 - "Community 170"
Cohesion: 1.0
Nodes (0): 

### Community 171 - "Community 171"
Cohesion: 1.0
Nodes (0): 

### Community 172 - "Community 172"
Cohesion: 1.0
Nodes (0): 

### Community 173 - "Community 173"
Cohesion: 1.0
Nodes (0): 

### Community 174 - "Community 174"
Cohesion: 1.0
Nodes (0): 

### Community 175 - "Community 175"
Cohesion: 1.0
Nodes (0): 

### Community 176 - "Community 176"
Cohesion: 1.0
Nodes (0): 

### Community 177 - "Community 177"
Cohesion: 1.0
Nodes (0): 

### Community 178 - "Community 178"
Cohesion: 1.0
Nodes (0): 

### Community 179 - "Community 179"
Cohesion: 1.0
Nodes (0): 

### Community 180 - "Community 180"
Cohesion: 1.0
Nodes (0): 

### Community 181 - "Community 181"
Cohesion: 1.0
Nodes (0): 

### Community 182 - "Community 182"
Cohesion: 1.0
Nodes (0): 

### Community 183 - "Community 183"
Cohesion: 1.0
Nodes (0): 

### Community 184 - "Community 184"
Cohesion: 1.0
Nodes (0): 

### Community 185 - "Community 185"
Cohesion: 1.0
Nodes (0): 

### Community 186 - "Community 186"
Cohesion: 1.0
Nodes (0): 

### Community 187 - "Community 187"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Community 96`** (2 nodes): `simulate.js`, `runSimulation()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 97`** (2 nodes): `audit.js`, `logAdminAction()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 98`** (2 nodes): `members-app.jsx`, `App()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 99`** (2 nodes): `members-icons.jsx`, `Icon()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 100`** (2 nodes): `clients.js`, `activateLocationMembersAdmin()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 101`** (2 nodes): `toast.js`, `showToast()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 102`** (2 nodes): `billing-snapshot.js`, `extractBillingSnapshot()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 103`** (2 nodes): `member-access-log.js`, `logMemberAccessEvent()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 104`** (2 nodes): `wix-app-market.js`, `handleAppMarketWebhook()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 105`** (2 nodes): `admin-operator-overview.spec.js`, `getDbStats()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 106`** (2 nodes): `admin-ui-walkthrough.spec.js`, `attachConsoleCapture()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 107`** (2 nodes): `api-auth-pin.spec.js`, `postPin()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 108`** (2 nodes): `api-operator-stats.spec.js`, `fetchOperator()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 109`** (2 nodes): `schema-indexes.spec.js`, `indexExists()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 110`** (2 nodes): `audit-by-internal-id.js`, `section()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 111`** (2 nodes): `audit-kisi.js`, `header()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 112`** (2 nodes): `audit-member.js`, `section()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 113`** (2 nodes): `member-cancels-loses-access.test.js`, `mockClientApiKey()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 114`** (2 nodes): `ob-125-source-tag-guard.test.js`, `mockSourceTagLookup()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 115`** (2 nodes): `queue-worker-new-schema.test.js`, `constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 116`** (2 nodes): `standard-adapter-new-schema.test.js`, `makeDbClient()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 117`** (2 nodes): `clients-kisi-user-pattern.test.js`, `mockDbForPattern()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 118`** (2 nodes): `middleware-actor-edge-cases.test.js`, `runMiddleware()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 119`** (2 nodes): `plan-mapping-resolver-new-schema.test.js`, `mockConnectorRow()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 120`** (2 nodes): `plan-mapping-resolver.test.js`, `mockMappingRow()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 121`** (2 nodes): `source-retry-probe.test.js`, `candidateRow()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 122`** (2 nodes): `wix-app-market-stub.test.js`, `mockRes()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 123`** (2 nodes): `diagnostic-log-db-sync.test.js`, `flushImmediate()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 124`** (2 nodes): `event-registry-sync.test.js`, `extractMarkdownEvents()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 125`** (2 nodes): `operator-members-disambiguation.test.js`, `makeApp()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 126`** (2 nodes): `wix-adapter-payment-guard.test.js`, `makeOrder()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 127`** (1 nodes): `jest.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 128`** (1 nodes): `playwright.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 129`** (1 nodes): `errors.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 130`** (1 nodes): `members.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 131`** (1 nodes): `portal.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 132`** (1 nodes): `queue.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 133`** (1 nodes): `webhooks.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 134`** (1 nodes): `wix-admins.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 135`** (1 nodes): `main.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 136`** (1 nodes): `plan-mapping-entry.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 137`** (1 nodes): `global-setup.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 138`** (1 nodes): `admin-access-log.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 139`** (1 nodes): `admin-dashboard.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 140`** (1 nodes): `admin-empty-states.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 141`** (1 nodes): `admin-error-queue.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 142`** (1 nodes): `admin-location-detail.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 143`** (1 nodes): `admin-location-list.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 144`** (1 nodes): `admin-responsive.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 145`** (1 nodes): `api-operator-locations.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 146`** (1 nodes): `logging-diagnostic-gaps.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 147`** (1 nodes): `logging-error-queue.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 148`** (1 nodes): `schema-effective-start.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 149`** (1 nodes): `schema-tables.spec.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 150`** (1 nodes): `lightbox.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 151`** (1 nodes): `multi-member-page.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 152`** (1 nodes): `thank-you-page.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 153`** (1 nodes): `audit-summary.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 154`** (1 nodes): `supabase-3-apply-data.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 155`** (1 nodes): `fixtures.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 156`** (1 nodes): `grant-retry-idempotency.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 157`** (1 nodes): `grant-revoke-new-schema.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 158`** (1 nodes): `kisi-user-pattern.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 159`** (1 nodes): `member-pays-gets-access.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 160`** (1 nodes): `ob-244-revoke-finds-removing-status.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 161`** (1 nodes): `ob-248-finalize-revoke.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 162`** (1 nodes): `ob-89-two-gate.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 163`** (1 nodes): `api-key-encryption.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 164`** (1 nodes): `billing-snapshot.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 165`** (1 nodes): `billing-subscriptions-wix-app-market-columns.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 166`** (1 nodes): `cron-trace.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 167`** (1 nodes): `kisi-user-explicit-flags.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 168`** (1 nodes): `logger-context-redaction.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 169`** (1 nodes): `logger-message-field.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 170`** (1 nodes): `member-access-sources-unique-constraint.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 171`** (1 nodes): `member-billing-cycle-transition.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 172`** (1 nodes): `member-sync-api-billing-conflation.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 173`** (1 nodes): `ob-240-migration.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 174`** (1 nodes): `ob-244-member-access-status-enum.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 175`** (1 nodes): `ob-247-pass-1-5-holder-lapse.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 176`** (1 nodes): `ob-249-pass-3-operator-delete-drift.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 177`** (1 nodes): `rate-limiter.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 178`** (1 nodes): `recon-traceid-guard.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 179`** (1 nodes): `reconcile-trigger-source.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 180`** (1 nodes): `reconciliation-new-schema.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 181`** (1 nodes): `reconciliation-pass2-source-lookup.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 182`** (1 nodes): `redaction-edge-cases.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 183`** (1 nodes): `schema-concepts-new.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 184`** (1 nodes): `snippet-registry.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 185`** (1 nodes): `trace-context-unhappy.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 186`** (1 nodes): `trace-propagation.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 187`** (1 nodes): `wix-adapter-parsing.test.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._