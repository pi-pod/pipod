import Observation
import SwiftUI

public enum AppTab: String, Hashable, CaseIterable, Sendable {
    case pods
    case jobs
    case settings

    public var title: String {
        switch self {
        case .pods: return "Pods"
        case .jobs: return "Jobs"
        case .settings: return "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .pods: return "shippingbox"
        case .jobs: return "calendar.badge.clock"
        case .settings: return "gearshape"
        }
    }
}

/// A screen inside the Pods tab.
public enum PodRoute: Hashable, Sendable {
    case detail(podId: String, pod: Pod?)
    /// A conversation is a focused screen: every chat app trades the tab bar for
    /// the transcript, and here it also stops the composer sitting on one.
    case session(podId: String, pod: Pod?, fromSeq: Int?, sessionId: String?)
    case launch
    /// Launching again from a pod that failed to provision. Retry travels
    /// explicitly rather than being inferred from a preselected environment: a
    /// pod launched without one has no `templateId` to infer it from, and would
    /// have titled the flow "New pod".
    case retryLaunch(templateId: String?)
    case approvals
    /// One approval in full. A value route rather than a `navigationDestination`
    /// bound to a selection: this stack is driven by `podsPath`, and a screen the
    /// path does not know about cannot be replaced, popped or reasoned about.
    case approvalDetail(interaction: PendingInteraction)
    /// The model and thinking-level picker for a live conversation.
    case modelPicker(podId: String)

    /// Whether this route is one of the two launch screens, for the launch view's
    /// own "replace me with the new pod" pop.
    var isLaunch: Bool {
        switch self {
        case .launch, .retryLaunch: return true
        case .detail, .session, .approvals, .approvalDetail, .modelPicker: return false
        }
    }
}

/// A screen inside the Jobs tab.
public enum JobRoute: Hashable, Sendable {
    case detail(jobId: String, job: Job?)
}

/// A screen inside the Settings tab.
public enum SettingsRoute: Hashable, Sendable {
    case environments
    case environmentDetail(templateId: String, template: PodTemplate?)
    case newEnvironment
    case credentials
    case proposals
    case proposalDetail(proposal: SettingsProposal)
    case configBundle(scope: ConfigBundleScope)
    case secrets(scope: String, scopeId: String, title: String)
    case planChange
}

public enum ConfigBundleScope: Hashable, Sendable {
    case organization(orgId: String)
    case user(userId: String)

    public var title: String {
        switch self {
        case .organization: return "Organization defaults"
        case .user: return "Your defaults"
        }
    }
}

/// Which tab is showing and what is stacked on it.
///
/// Deep links land here rather than in a view, so a notification that arrives
/// while the app is signed out can be replayed once sign-in finishes instead of
/// being dropped.
@MainActor
@Observable
public final class AppRouter {
    public var selectedTab: AppTab = .pods
    public var podsPath: [PodRoute] = []
    public var jobsPath: [JobRoute] = []
    public var settingsPath: [SettingsRoute] = []

    /// One-shot handoff state for a pod that was just created. It lives in the
    /// router rather than a launch screen that is about to disappear, so the
    /// conversation can focus its composer and show the launch report exactly
    /// once after navigation.
    private var pendingComposerFocusPodID: String?
    private var pendingLaunchReports: [String: LaunchReport] = [:]

    public init() {}

    /// Drops every stacked screen and returns to the pod list.
    ///
    /// Navigation belongs to a session: after a sign-out or an organization
    /// switch the stack names pods, jobs and settings the next person may not
    /// even be able to see, and the screens under it would fetch them.
    public func reset() {
        selectedTab = .pods
        podsPath.removeAll()
        jobsPath.removeAll()
        settingsPath.removeAll()
        pendingComposerFocusPodID = nil
        pendingLaunchReports.removeAll()
    }

    public func openPods() {
        selectedTab = .pods
        podsPath.removeAll()
    }

    public func openSession(
        podId: String, pod: Pod? = nil, fromSeq: Int? = nil, sessionId: String? = nil
    ) {
        selectedTab = .pods
        pendingComposerFocusPodID = nil
        pendingLaunchReports.removeValue(forKey: podId)
        // Re-entering the same conversation from a notification must not stack a
        // second copy of it behind the first.
        podsPath.removeAll { route in
            if case .session(let existing, _, _, _) = route { return existing == podId }
            return false
        }
        podsPath.append(
            .session(podId: podId, pod: pod, fromSeq: fromSeq, sessionId: sessionId)
        )
    }

    /// A successful create is already the user's commitment. Replace the launch
    /// screen with the conversation instead of making them find the session
    /// through pod details, while carrying the report to the screen that can
    /// explain it without blocking the first prompt.
    public func openSessionFromLaunch(_ response: LaunchResponse) {
        selectedTab = .pods
        var path = podsPath
        if let index = path.lastIndex(where: \.isLaunch) {
            path.removeSubrange(index...)
        }
        path.removeAll { route in
            if case .session(let existing, _, _, _) = route { return existing == response.pod.id }
            return false
        }
        pendingComposerFocusPodID = response.pod.id
        pendingLaunchReports[response.pod.id] = response.report
        path.append(
            .session(
                podId: response.pod.id, pod: response.pod, fromSeq: nil, sessionId: nil
            )
        )
        podsPath = path
    }

    /// Consumed by the freshly-created session once. Reopening the same pod from
    /// a notification or the list must not steal focus from an existing draft.
    public func consumeComposerFocus(for podID: String) -> Bool {
        guard pendingComposerFocusPodID == podID else { return false }
        pendingComposerFocusPodID = nil
        return true
    }

    /// Consumed by the destination session. A report belongs to the create that
    /// produced it, not to a pod detail screen that may never be visited.
    public func consumeLaunchReport(for podID: String) -> LaunchReport? {
        pendingLaunchReports.removeValue(forKey: podID)
    }

    public func openPod(_ podId: String, pod: Pod? = nil) {
        selectedTab = .pods
        podsPath.append(.detail(podId: podId, pod: pod))
    }

    public func openApprovals() {
        selectedTab = .pods
        podsPath = [.approvals]
    }

    /// Leaves one approval's own screen. Answering it, or opening the pod it came
    /// from, both turn that screen into a page about a question nobody is asking.
    public func closeApprovalDetail() {
        podsPath.removeAll { route in
            if case .approvalDetail = route { return true }
            return false
        }
    }

    /// An approval is answered in context: the pod's conversation is where the
    /// request came from. The request's own screen does not stay behind it.
    public func openSessionFromApproval(podId: String) {
        closeApprovalDetail()
        openSession(podId: podId)
    }

    public func openModelPicker(podId: String) {
        selectedTab = .pods
        guard podsPath.last != .modelPicker(podId: podId) else { return }
        podsPath.append(.modelPicker(podId: podId))
    }

    public func openProposal(_ proposal: SettingsProposal) {
        selectedTab = .settings
        settingsPath.append(.proposalDetail(proposal: proposal))
    }

    public func openJob(_ jobId: String, job: Job? = nil) {
        selectedTab = .jobs
        jobsPath = [.detail(jobId: jobId, job: job)]
    }

    /// Routes a deep link. Interactions without a pod land on the inbox; a job
    /// without a pod lands on the job; everything else opens the session.
    public func handle(_ destination: DeepLinkDestination) {
        if let podId = destination.podId, !podId.isEmpty {
            openSession(
                podId: podId, fromSeq: destination.fromSeq, sessionId: destination.sessionId
            )
            return
        }
        if let jobId = destination.jobId, !jobId.isEmpty {
            openJob(jobId)
            return
        }
        if destination.interactionId != nil {
            openApprovals()
            return
        }
        openPods()
    }
}
