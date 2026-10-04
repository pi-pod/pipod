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
    /// The model and thinking-level picker for a live conversation.
    case modelPicker(podId: String)

    /// Whether this route is one of the two launch screens, for the launch view's
    /// own "replace me with the new pod" pop.
    var isLaunch: Bool {
        switch self {
        case .launch, .retryLaunch: return true
        case .detail, .session, .modelPicker: return false
        }
    }

    /// The pod this screen belongs to, if it belongs to one.
    var podID: String? {
        switch self {
        case .detail(let id, _), .session(let id, _, _, _), .modelPicker(let id): return id
        case .launch, .retryLaunch: return nil
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
    case credentials
    case secrets(scope: String, scopeId: String, title: String)
    case planChange
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

    /// Leaves every screen of a pod that no longer exists — its conversation as well as its
    /// details — back to wherever it was opened from.
    public func closePod(_ podId: String) {
        if let first = podsPath.firstIndex(where: { $0.podID == podId }) {
            podsPath.removeSubrange(first...)
        }
    }

    public func openPod(_ podId: String, pod: Pod? = nil) {
        selectedTab = .pods
        podsPath.append(.detail(podId: podId, pod: pod))
    }

    public func openModelPicker(podId: String) {
        selectedTab = .pods
        guard podsPath.last != .modelPicker(podId: podId) else { return }
        podsPath.append(.modelPicker(podId: podId))
    }

    public func openJob(_ jobId: String, job: Job? = nil) {
        selectedTab = .jobs
        jobsPath = [.detail(jobId: jobId, job: job)]
    }

    /// Routes a deep link: a pod opens its session, a job without a pod opens
    /// the job, and anything else lands on the pod list.
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
        openPods()
    }
}
