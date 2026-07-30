export { createNodeGitProcess } from "./git-process.js";
export { createNativeGitVcsBackend } from "./vcs-backend-native-git.js";
export { BlobCorruptionError, createFileContentBlobStore } from "./blob/file-content-blob-store.js";
export type {
  BlobCorruptionErrorCode,
  CreateFileContentBlobStoreOptions,
} from "./blob/file-content-blob-store.js";

export type { SchedulerStore, SteeringCommandStore } from "@minions/core";

export { inspectRepository, RepositoryInspectionError } from "./repository-inspector.js";
export type {
  RepositoryInspection,
  RepositoryInspectionErrorCode,
} from "./repository-inspector.js";
export { createSecureIdGenerator } from "./secure-id-generator.js";
export {
  acquireLifecycleLock,
  daemonLifecyclePath,
  inspectLifecycleLock,
  LifecycleLockError,
} from "./lifecycle-lock.js";
export type {
  AcquiredLifecycleLock,
  AcquireLifecycleLockOptions,
  DaemonLifecycleRecord,
  DaemonModeName,
  LifecycleLockErrorCode,
  LifecycleLockInspection,
} from "./lifecycle-lock.js";
export { createEventCommitWaiter } from "./event-commit-waiter.js";
export type {
  EventCommitWaiter,
  EventCommitWaitOptions,
  EventCommitWaitResult,
} from "./event-commit-waiter.js";
export { SqliteCommandError } from "./sqlite/command-error.js";
export type { SqliteCommandErrorCode } from "./sqlite/command-error.js";
export { createSqliteCommandStore } from "./sqlite/command-store.js";
export type {
  ApplySqliteCommand,
  CommandCommitNotifier,
  OpenSqliteCommandStoreOptions,
  SqliteCommandStore,
  SqliteCommandTransaction,
} from "./sqlite/command.js";
export { createSteeringCommandDispatcher } from "./steering-command-dispatcher.js";
export {
  createSqliteSteeringCommandStore,
  SqliteSteeringError,
} from "./sqlite/steering-command-store.js";
export type {
  CreateSqliteSteeringCommandStoreOptions,
  SqliteSteeringErrorCode,
} from "./sqlite/steering-command-store.js";
export { createSqliteEventStore } from "./sqlite/event-store.js";
export type {
  OpenSqliteEventStoreOptions,
  SqliteAttentionSummary,
  SqliteEventBounds,
  SqliteEventSnapshot,
  SqliteEventStore,
  SqliteHostSummary,
  SqliteNodeSummary,
  SqliteRepositorySummary,
  SqliteStoredEvent,
  SqliteTreeSummary,
} from "./sqlite/event-store.js";
export { createSupervisorHostRegistry, HostRegistryError } from "./sqlite/host-registry.js";
export type {
  CreateSupervisorHostRegistryOptions,
  EnsureLocalHostInput,
  ExecutionHostKind,
  ExecutionHostRecord,
  ExecutionHostState,
  HostRegistryErrorCode,
  ListExecutionHostsInput,
  RegisterSshHostInput,
  SupervisorHostRegistry,
} from "./sqlite/host-registry.js";
export { createRepositoryRegistry, RepositoryRegistryError } from "./sqlite/repository-registry.js";
export type {
  CreateRepositoryRegistryOptions,
  ListRepositoriesInput,
  RegisterRepositoryInput,
  RepositoryRegistration,
  RepositoryRegistry,
  RepositoryRegistryErrorCode,
} from "./sqlite/repository-registry.js";
export { createPlanRegistry, PlanRegistryError } from "./sqlite/plan-registry.js";
export type {
  ApprovePlanInput,
  ArtifactInputRecord,
  ArtifactOutputRecord,
  CreatePlanRegistryOptions,
  CreateTreeInput,
  ImplementationOutputRecord,
  ListTreesInput,
  PlanAttentionRecord,
  PlanRegistry,
  PlanRegistryErrorCode,
  PlanRevisionRecord,
  ProposePlanInput,
  RepairPlanInput,
  TaskNodeOutputRecord,
  TaskNodeRecord,
  TreeBudgetRecord,
  TreeRecord,
  TreeSummaryRecord,
} from "./sqlite/plan-registry.js";
export { createSqliteArtifactRegistry, ArtifactRegistryError } from "./sqlite/artifact-registry.js";
export type {
  ArtifactRegistryErrorCode,
  CreateSqliteArtifactRegistryOptions,
} from "./sqlite/artifact-registry.js";
export { createSqliteSchedulerStore, SqliteSchedulerError } from "./sqlite/scheduler-store.js";
export type {
  CreateSqliteSchedulerStoreOptions,
  SqliteSchedulerErrorCode,
} from "./sqlite/scheduler-store.js";
export {
  createSqliteGitMutationLeaseStore,
  createSqliteWorkspaceRegistry,
  GitMutationLeaseError,
  SqliteGitMutationLeaseStore,
  SqliteWorkspaceRegistry,
  WorkspaceRegistryError,
} from "./sqlite/workspace-registry.js";
export type {
  CreateSqliteGitMutationLeaseStoreOptions,
  CreateSqliteWorkspaceRegistryOptions,
  GitMutationLease,
  GitMutationLeaseAcquireInput,
  GitMutationLeaseErrorCode,
  GitMutationLeaseAssertHeldInput,
  GitMutationLeaseReleaseInput,
  GitMutationLeaseRenewInput,
  GitMutationLeaseStore,
  WorkspaceBeginInput,
  WorkspaceCleanedInput,
  WorkspaceCleanupInput,
  WorkspaceFailedInput,
  WorkspaceReadyInput,
  WorkspaceRegistry,
  WorkspaceRegistryErrorCode,
} from "./sqlite/workspace-registry.js";
export { createWorkspaceManager, WorkspaceManagerError } from "./workspace-manager.js";
export type {
  WorkspaceCreateInput,
  WorkspaceManager,
  WorkspaceManagerCleanupInput,
  WorkspaceManagerErrorCode,
  WorkspaceManagerOptions,
  WorkspaceStatusInput,
} from "./workspace-manager.js";
export { openHostDatabase, openSupervisorDatabase } from "./sqlite/database.js";
export type {
  ManagedSqliteDatabase,
  OpenSqliteDatabaseOptions,
  SqliteReader,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
  SqliteWriteResult,
} from "./sqlite/database.js";
export { SqliteDatabaseError } from "./sqlite/error.js";
export type { SqliteDatabaseErrorCode } from "./sqlite/error.js";
export {
  hostMigrations,
  migrationsByDatabaseKind,
  supervisorMigrations,
} from "./sqlite/generated-migrations.js";
export type { DatabaseKind, MigrationReceipt, SqliteMigration } from "./sqlite/migration.js";
export { createSqliteTranscriptStore, SqliteTranscriptError } from "./sqlite/transcript-store.js";
export type {
  CreateSqliteTranscriptStoreOptions,
  SqliteTranscriptErrorCode,
} from "./sqlite/transcript-store.js";
export { createSqliteCheckpointStore, SqliteCheckpointError } from "./sqlite/checkpoint-store.js";
export type {
  CreateSqliteCheckpointStoreOptions,
  SqliteCheckpointErrorCode,
} from "./sqlite/checkpoint-store.js";
export { createSqliteVcsChangeBindingStore } from "./sqlite/vcs-change-binding-store.js";
export type { CreateSqliteVcsChangeBindingStoreOptions } from "./sqlite/vcs-change-binding-store.js";
export {
  bindingFingerprint,
  CONFLICT_STATES,
  isValidConflictTransition,
  validateVcsChangeBinding,
  VcsChangeBindingStoreError,
} from "@minions/core";
export type {
  ConflictState,
  RewriteGeneration,
  VcsChangeBinding,
  VcsChangeBindingStore,
  VcsChangeBindingStoreErrorCode,
} from "@minions/core";
export {
  buildStackPath,
  determineBaseBranch,
  determineBranchName,
  retargetAfterLanding,
  shortIdentity,
  STACK_BRANCH_PREFIX,
  STACK_NODE_SHORT_LENGTH,
  STACK_TREE_SHORT_LENGTH,
  STACK_TRUNK_BRANCH,
  StackParentageError,
} from "@minions/core";
export type {
  RetargetPlan,
  StackNode,
  StackParentageErrorCode,
  StackPosition,
} from "@minions/core";
export { createExecutionCoordinator, ExecutionCoordinatorError } from "./execution-coordinator.js";
export type {
  ExecutionCoordinatorOptions,
  ExecutionCoordinatorErrorCode,
} from "./execution-coordinator.js";
export { createRepairCoordinator, RepairCoordinatorError } from "./repair-coordinator.js";
export type {
  AttemptRepairInput,
  RepairAttentionSink,
  RepairCoordinator,
  RepairCoordinatorErrorCode,
  RepairCoordinatorOptions,
} from "./repair-coordinator.js";
export {
  canRetry,
  classifyFailure,
  consume,
  createRetryBudget,
  decideRepair,
  DEFAULT_REPAIR_CEILING,
  IS_BLOCKER_FAILURE_CLASS,
  IS_TERMINAL_FAILURE_CLASS,
  isNoProgress,
  signaturesEqual,
} from "@minions/core";
export type {
  FailureClass,
  NoProgressSignature,
  RepairAction,
  RepairAttemptEvidence,
  RepairAttention,
  RepairAttentionKind,
  RepairDecision,
  RepairEvidenceRef,
  RepairOutcome,
  RepairStatus,
  RetryBudget,
} from "@minions/core";
export {
  createSandboxPolicyFingerprinter,
  fingerprintSandboxPolicy,
  SandboxPolicyError,
  SandboxPolicyFingerprinter,
  serializeSandboxPolicy,
  validateSandboxPolicy,
} from "./sandbox-policy.js";
export type { SandboxPolicyErrorCode } from "./sandbox-policy.js";
export {
  createProductionSandboxLifecycle,
  ProductionSandboxLifecycleError,
} from "./sandbox-lifecycle.js";
export type {
  CreateProductionSandboxLifecycleOptions,
  ProductionSandboxLifecycle,
  ProductionSandboxLifecycleErrorCode,
} from "./sandbox-lifecycle.js";
export { LimaTemplateError, prepareLimaTemplate, verifyLimaTemplate } from "./lima-template.js";
export type {
  LimaRuntimeArtifact,
  LimaTemplateBuildOptions,
  LimaTemplateErrorCode,
  LimaTemplateReceipt,
} from "./lima-template.js";
export { createMacOsLimaSandboxLifecycle, MacOsLimaSandboxError } from "./lima-sandbox.js";
export type { MacOsLimaSandboxErrorCode, MacOsLimaSandboxOptions } from "./lima-sandbox.js";
export { PodmanImageError, preparePodmanImage, verifyPodmanImage } from "./podman-image.js";
export type {
  PodmanImageBuildOptions,
  PodmanImageErrorCode,
  PodmanImageReceipt,
  PodmanRuntimeArtifact,
} from "./podman-image.js";
export {
  createLinuxPodmanSandboxLifecycle,
  createWsl2PodmanSandboxLifecycle,
  PodmanSandboxError,
} from "./podman-sandbox.js";
export type { PodmanSandboxErrorCode, PodmanSandboxOptions } from "./podman-sandbox.js";
export {
  createOmpAcpHarnessAdapter,
  OmpAcpAdapterError,
  buildSessionNewParams,
  resolveOmpPath,
} from "./omp-acp-adapter.js";
export type {
  AcpFrame,
  AcpRpcError,
  DecodeAcpFrameResult,
  OmpAcpAdapterOptions,
  OmpAcpAdapterErrorCode,
} from "./omp-acp-adapter.js";
export { decodeAcpFrame, normalizeAcpNotification } from "./omp-acp-adapter.js";
export { PINNED_JJ_VERSION, ensureJjCapability, JjCapabilityError } from "./jj-capability.js";
export type {
  JjCapabilities,
  JjCapabilityErrorCode,
  JjCapabilityOptions,
  JjCapabilityProbe,
} from "./jj-capability.js";
export { createRevsetManager, RevsetManagerError } from "./revset-adapter.js";
export type {
  NodeImpact,
  NodeReadiness,
  RevsetErrorCode,
  RevsetJjRunResult,
  RevsetJjRunner,
  RevsetManager,
  RevsetManagerOptions,
} from "./revset-adapter.js";
export { createSshConnection, SshAdapterError } from "./ssh-adapter.js";
export type {
  SshAdapterOptions,
  SshConnection,
  SshConnectionState,
  SshErrorCode,
  SshRunResult,
  SshRunner,
} from "./ssh-adapter.js";
export { createReconnectStrategy } from "./ssh-reconnect.js";
export type { ReconnectStrategy, ReconnectStrategyOptions } from "./ssh-reconnect.js";
export {
  buildRevsetExpression,
  EMPTY_REVSET,
  filterBindings,
  REVSET_QUERY_KINDS,
  treeUnion,
} from "@minions/core";
export type {
  RevsetExpressionScope,
  RevsetQuery,
  RevsetQueryKind,
  RevsetResult,
} from "@minions/core";
export { createJjCentralRepoManager, JjCentralRepoError } from "./jj-central-repo.js";
export type {
  JjCentralRepo,
  JjCentralRepoErrorCode,
  JjCentralRepoManager,
  JjCentralRepoManagerOptions,
  JjPreSnapshotReport,
} from "./jj-central-repo.js";
export {
  JJ_METADATA_DIR,
  createJjWorkingCopyManager,
  JjWorkingCopyError,
  pathContainsDotJj,
} from "./jj-working-copy.js";
export type {
  AuthorIdentity,
  JjCommitReceipt,
  JjNewChangeReceipt,
  JjRevisionDescriptor,
  JjSplitReceipt,
  JjSquashReceipt,
  JjWorkingCopy,
  JjWorkingCopyDiff,
  JjWorkingCopyErrorCode,
  JjWorkingCopyHead,
  JjWorkingCopyManager,
  JjWorkingCopyManagerOptions,
  JjWorkingCopyStatus,
} from "./jj-working-copy.js";
export {
  createCommitCaptureManager,
  CommitCaptureError,
  DETERMINISTIC_ENGINE_IDENTITY,
} from "./commit-capture.js";
export type {
  ChildBaseResolution,
  CommitCaptureInput,
  CommitCaptureManager,
  CommitCaptureManagerOptions,
  CommitCaptureNodeKind,
  CommitCaptureReceipt,
  CommitCaptureErrorCode,
  CommitCaptureLogger,
  CommitCaptureTree,
  CommitCaptureWorkingCopy,
  StaleDescendant,
} from "./commit-capture.js";
export { checkJjCompatibility } from "./jj-capability-gates.js";
export type {
  JjCompatibilityDenial,
  JjCompatibilityDenialCode,
  JjCompatibilityGateOptions,
  JjCompatibilityReport,
} from "./jj-capability-gates.js";
export { CredentialVaultError, createCredentialVault } from "./credential-vault.js";
export type {
  CredentialVault,
  CredentialVaultBackend,
  CredentialVaultErrorCode,
  CredentialVaultOptions,
  CredentialVaultProbeResult,
  SystemdCredsKeyMode,
} from "./credential-vault.js";
export {
  AuthBrokerError,
  createAuthBrokerManager,
  parseJsonObject,
  reserveLoopbackPort,
  runOmp,
  runOmpJson,
} from "./auth-broker.js";
export type {
  AuthBrokerErrorCode,
  AuthBrokerHealth,
  AuthBrokerLogger,
  AuthBrokerLoginOptions,
  AuthBrokerManager,
  AuthBrokerManagerOptions,
  OmpJsonResult,
} from "./auth-broker.js";
export { AuthGatewayError, createAuthGatewayManager } from "./auth-gateway.js";
export type {
  AttemptCapability,
  AuthGatewayErrorCode,
  AuthGatewayHealth,
  AuthGatewayLogger,
  AuthGatewayManager,
  AuthGatewayManagerOptions,
} from "./auth-gateway.js";
export { ProviderAdmissionError, createProviderAdmissionProxy } from "./provider-admission.js";
export type {
  ProviderAdmissionErrorCode,
  ProviderAdmissionProxy,
  ProviderAdmissionProxyOptions,
} from "./provider-admission.js";
export {
  defaultSecretPatterns,
  redactObject,
  redactSecrets,
  scanForSecrets,
} from "./secret-redaction.js";
export type {
  KnownSecret,
  RedactOptions,
  ScanOptions,
  SecretPattern,
  SecretScanHit,
  SecretScanTarget,
  SecretScanTargetKind,
} from "./secret-redaction.js";
export {
  assertProfileDoesNotWeaken,
  computeGateProfileHash,
  GateProfileError,
  gateCategoryFromName,
  gateCategoryName,
  loadGateProfile,
  parseGateProfile,
  profileWeakensBaseline,
  serializeGateProfile,
  validateGateProfile,
} from "./gate-profile.js";
export type {
  GateCommandLike,
  GateEntryLike,
  GateEnvPolicyLike,
  GateNetworkPolicyLike,
  GatePathPolicyLike,
  GateProfileInput,
  GateProfileLike,
  GateValidatedEntry,
  GateWorktreePolicyLike,
  GateProfileErrorCode,
  HostGateMinimum,
  LoadedGateProfile,
} from "./gate-profile.js";
export { createGateRunner } from "./gate-runner-adapter.js";
export type { CreateGateRunnerOptions } from "./gate-runner-adapter.js";
export { createSqliteGateReceiptStore } from "./sqlite/gate-receipt-store.js";
export type { CreateSqliteGateReceiptStoreOptions } from "./sqlite/gate-receipt-store.js";
export {
  classifyOutcome,
  computeEnvironmentDigest,
  GateReceiptStoreError,
  GateRunnerError,
  isReceiptStale,
  probeGateCommand,
  validateGateReceipts,
  validateGateRunRequest,
} from "@minions/core";
export type {
  GateAbortListener,
  GateAbortOptions,
  GateAbortSignal,
  GateCategoryValue,
  GateCommandDescriptor,
  GateOutcome,
  GateReceipt,
  GateReceiptBindings,
  GateReceiptExpectation,
  GateReceiptRecord,
  GateReceiptStore,
  GateReceiptStoreErrorCode,
  GateRunner,
  GateRunnerErrorCode,
  GateRunnerPorts,
  GateRunRequest,
  GateValidation,
  GateValidationProblem,
} from "@minions/core";
export { createSqliteRecoveryStore } from "./sqlite/recovery-store.js";
export type { CreateSqliteRecoveryStoreOptions } from "./sqlite/recovery-store.js";
export {
  createAuditEntry,
  RecoveryStoreError,
  resolveGrantApproval,
  validateActionAgainstGrant,
  validateElevationRequest,
  validateRecoveryAction,
} from "@minions/core";
export type {
  ElevationGrant,
  ElevationGrantState,
  ElevationRequestVerdict,
  RecordedRecoveryAction,
  RecoveryAction,
  RecoveryActionKind,
  RecoveryActionState,
  RecoveryActionVerdict,
  RecoveryAuditEntry,
  RecoveryGateProfile,
  RecoveryStore,
  RecoveryStoreErrorCode,
} from "@minions/core";
export { GitHubClientError, appBotLogin, createGitHubClient } from "./github-client.js";
export type {
  GitHubAppInfo,
  GitHubBranchProtection,
  GitHubBranchProtectionPullRequestReviews,
  GitHubBypassActor,
  GitHubBypassActorType,
  GitHubBypassMode,
  GitHubClient,
  GitHubClientErrorCode,
  GitHubClientOptions,
  GitHubFetch,
  GitHubInstallationRepository,
  GitHubInstallationToken,
  GitHubPullRequestParameters,
  GitHubRepositoryInstallation,
  GitHubRule,
  GitHubRuleType,
  GitHubRulesetConfig,
  GitHubRulesetDetail,
  GitHubRulesetEnforcement,
  GitHubRulesetRuleConfig,
  GitHubRulesetSummary,
  GitHubRulesetTarget,
  GitHubUser,
  GitHubUserType,
  GitHubCheckConclusion,
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubCombinedStatus,
  GitHubCombinedStatusState,
  GitHubCreatePullRequestInput,
  GitHubGitRef,
  GitHubMergeMethod,
  GitHubMergePullRequestInput,
  GitHubMergeResult,
  GitHubPullRequest,
  GitHubPullRequestListOptions,
  GitHubPullRequestListState,
  GitHubPullRequestState,
  GitHubReview,
  GitHubReviewState,
  GitHubUpdatePullRequestInput,
} from "./github-client.js";
export { GitHubAppAuthError, createGitHubAppAuth } from "./github-app-auth.js";
export type {
  BotIdentity,
  GitHubAppAuth,
  GitHubAppAuthErrorCode,
  GitHubAppAuthLogger,
  GitHubAppAuthOptions,
  GitHubInstallationTokenHandle,
} from "./github-app-auth.js";
export {
  GitHubRulesetError,
  MINIONS_REVIEW_RULESET_NAME,
  REQUIRED_REVIEW_POLICY,
  detectDrift,
  inspectRuleset,
  installRuleset,
  onboardRepository,
  resolveEngineBotIdentity,
} from "./github-ruleset.js";
export type {
  DetectDriftOptions,
  DriftFinding,
  DriftFindingKind,
  DriftReport,
  DriftStatus,
  GitHubReviewPolicy,
  GitHubRulesetClassification,
  GitHubRulesetErrorCode,
  GitHubRulesetFinding,
  GitHubRulesetFindingKind,
  GitHubRulesetReceipt,
  GitHubRulesetReport,
  InspectRulesetOptions,
  InstallAction,
  InstallRulesetOptions,
  OnboardRepositoryOptions,
  RepositoryOnboardingReceipt,
} from "./github-ruleset.js";
export { PushError, createPushManager } from "./github-push.js";
export type {
  PushAction,
  PushErrorCode,
  PushInput,
  PushManager,
  PushManagerOptions,
  PushReceipt,
  PushWorkingCopy,
} from "./github-push.js";
export { PullRequestError, createPullRequestManager } from "./github-pull-request.js";
export type {
  CheckSummary,
  CheckSummaryState,
  PullRequestAction,
  PullRequestErrorCode,
  PullRequestInput,
  PullRequestManager,
  PullRequestManagerOptions,
  PullRequestReceipt,
  ReviewApprovalSummary,
  ReviewObservation,
  ReviewState,
} from "./github-pull-request.js";
export { RemoteCiError, createRemoteCiManager } from "./remote-ci-adapter.js";
export type {
  CiNodeRepairInput,
  CiRepairHarness,
  CiRepairOutcome,
  CiRepairOutcomeStatus,
  RemoteCiErrorCode,
  RemoteCiManager,
  RemoteCiManagerOptions,
  RemoteCiObservationInput,
  RemoteCiRepairInput,
  RemoteCiWaitInput,
} from "./remote-ci-adapter.js";
export {
  allRequiredPresent,
  classifyOverall,
  FAILURE_VERDICTS,
  findCheck,
  isBaseFailure,
  isCheckPassing,
  isFailureVerdict,
  isStaleCheck,
  isTerminalVerdict,
  TERMINAL_VERDICTS,
} from "@minions/core";
export type {
  CheckObservation,
  CheckVerdict,
  CiEvidence,
  CiOverallVerdict,
  RequiredCheckSet,
} from "@minions/core";
export { createStackParentageManager } from "./stack-parentage-adapter.js";
export type {
  StackParentageManager,
  StackParentageManagerOptions,
} from "./stack-parentage-adapter.js";
export { createRestackCoordinator, RestackError } from "./restack-coordinator.js";
export type {
  RestackAttentionKind,
  RestackAttentionSink,
  RestackCoordinator,
  RestackCoordinatorOptions,
  RestackErrorCode,
  RestackHumanAttention,
  RestackLogger,
  RestackRebaseAncestry,
  RestackRebaseOutcome,
  RestackRepairAttemptOutcome,
  RestackRepairHarness,
  RestackSquashReceipt,
  RestackStaleSink,
  RestackWorkingCopy,
} from "./restack-coordinator.js";
// PR 36 — explicit landing reconciliation (core domain re-export + coordinator).
export {
  evaluatePreflight,
  humanApproval,
  isAlreadyLanded,
  LandingReceiptStoreError,
  validateLandingIntent,
} from "@minions/core";
export type {
  HumanApproval,
  LandingIntent,
  LandingMergeMethod,
  LandingPreflight,
  LandingReceipt,
  LandingReceiptStore,
  LandingReceiptStoreErrorCode,
  LandingRequestedBy,
  LandingVerdict,
} from "@minions/core";
export { createLandingCoordinator, LandingError } from "./landing-coordinator.js";
export type {
  LandingCoordinator,
  LandingCoordinatorOptions,
  LandingErrorCode,
  LandingNodeResolver,
  LandingPolicy,
  LandingRulesetGate,
} from "./landing-coordinator.js";
// PR 37 — ordered crash recovery + retention (core domain re-export + coordinator).
export {
  MILLIS_PER_DAY,
  orderedPhases,
  recoveryBoundary,
  recoveryError,
  recoveryReport,
  retentionPolicy,
  shouldCompact,
  shouldPurge,
} from "@minions/core";
export type {
  RecoveryBoundary,
  RecoveryBoundaryStatus,
  RecoveryError,
  RecoveryPhase,
  RecoveryReport,
  RetentionEvaluation,
  RetentionPolicy,
} from "@minions/core";
export {
  blobReconciler,
  createRecoveryCoordinator,
  RecoveryCoordinatorError,
  schedulerLeaseReconciler,
  workspaceReconciler,
} from "./recovery-coordinator.js";
export type {
  CompactionReport,
  PhaseReconciliation,
  PurgeReport,
  RecoveryCompactor,
  RecoveryCoordinator,
  RecoveryCoordinatorErrorCode,
  RecoveryCoordinatorOptions,
  RecoveryLogger,
  RecoveryPurger,
  RecoveryReconciler,
} from "./recovery-coordinator.js";
// PR 39 — fixup targeting via jj absorb (core domain re-export + coordinator).
export { previewAffectedChanges, validateFixupTarget } from "@minions/core";
export type { FixupPreview, FixupResult, FixupTarget, FixupTargetVerdict } from "@minions/core";
export {
  changeIdFingerprint,
  createFixupCoordinator,
  DEFAULT_FIXUP_COMMIT_MESSAGE,
  FixupError,
} from "./fixup-coordinator.js";
export type {
  AbsorbOutcome,
  AbsorbReceipt,
  FixContent,
  FixupCoordinator,
  FixupCoordinatorOptions,
  FixupErrorCode,
  FixupLogger,
  FixupWorkingCopy,
} from "./fixup-coordinator.js";

export { createJjChangeIdRegistry, JjChangeIdRegistryError } from "./jj-change-registry.js";
export type {
  JjChangeIdRegistry,
  JjChangeIdRegistryErrorCode,
  ResolvedJjChange,
} from "./jj-change-registry.js";
export {
  createProductionFixupWorkingCopy,
  ProductionFixupWorkingCopyError,
} from "./fixup-working-copy.js";
export type {
  ProductionFixupWorkingCopy,
  ProductionFixupWorkingCopyErrorCode,
} from "./fixup-working-copy.js";

// PR 40 — plan repair via split (core domain re-export + coordinator).
export { computeResultingTopology, previewSplit, validateSplitProposal } from "@minions/core";
export type {
  AssignedChildIdentity,
  ExistingTreeNode,
  HunkRange,
  SplitPlan,
  SplitPreview,
  SplitProposal,
  SplitProposalContext,
  SplitProposalVerdict,
  SplitResultNode,
  SplitSegment,
  SplitSegmentPreview,
} from "@minions/core";
export { createSplitCoordinator, SplitError } from "./split-coordinator.js";
export type {
  ExecuteSplitOptions,
  SplitChildRecord,
  SplitCoordinator,
  SplitCoordinatorOptions,
  SplitErrorCode,
  SplitLogger,
  SplitPlanRegistry,
  SplitRecordInput,
  SplitRecordResult,
  SplitSegmentReceipt,
  SplitWorkingCopy,
} from "./split-coordinator.js";

export {
  createProductionSplitWorkingCopy,
  ProductionSplitWorkingCopyError,
} from "./split-working-copy.js";
export type {
  ProductionSplitWorkingCopy,
  ProductionSplitWorkingCopyErrorCode,
} from "./split-working-copy.js";
// PR 41 — per-revision gates via jj run (core domain re-export + runner).
export { buildRevisionRevset, validateNoUnexpectedMutation } from "@minions/core";
export type {
  MutationProof,
  RevisionGateRequest,
  RevisionGateResult,
  RevisionIdSnapshot,
  RevisionOutcome,
} from "@minions/core";
export { createRevisionGateRunner, RevisionGateError } from "./revision-gate-runner.js";
export type {
  RevisionGateErrorCode,
  RevisionGateJjRunner,
  RevisionGateRawResult,
  RevisionGateRunner,
  RevisionGateRunnerOptions,
  RevisionGateRevisionRunner,
  RevisionOperationIdFn,
  RevisionRestoreOpFn,
  RevisionSnapshotFn,
} from "./revision-gate-runner.js";

export { createWslRequirementProbe, WslProbeError } from "./wsl-probe.js";
export type {
  CommandResult,
  CommandRunner,
  LoopbackProber,
  StorageProber,
  WslProbeOptions,
  WslProbeErrorCode,
  WslRequirementProbe,
} from "./wsl-probe.js";

export { createTailscaleProbe } from "./tailscale-probe.js";
export type {
  TailscaleCommandResult,
  TailscaleCommandRunner,
  TailscaleProbe,
  TailscaleProbeOptions,
} from "./tailscale-probe.js";
