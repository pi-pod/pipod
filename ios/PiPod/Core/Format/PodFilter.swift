import Foundation

/// What the pod list is showing right now. Kept as a plain value so the rules are
/// testable on their own and the list view stays about presentation.
public struct PodFilter: Equatable, Sendable {
    public var status: PodFilterStatus = .active
    public var project: PodFilterProject = .any
    public var environment: PodFilterEnvironment = .any
    public var onlyMine = false
    public var search = ""

    public init(
        status: PodFilterStatus = .active,
        project: PodFilterProject = .any,
        environment: PodFilterEnvironment = .any,
        onlyMine: Bool = false,
        search: String = ""
    ) {
        self.status = status
        self.project = project
        self.environment = environment
        self.onlyMine = onlyMine
        self.search = search
    }

    /// The screen's resting state. Search is deliberately not part of it: the
    /// search field shows its own text and clears itself, so it never needs a
    /// second escape hatch.
    public var isDefault: Bool {
        status == .active && project == .any && environment == .any && !onlyMine
    }

    /// Everything "Clear filters" undoes — the search text included. A list that
    /// is still narrowed by a query someone typed is not a cleared list, and the
    /// control that says it cleared one must not leave that behind.
    public mutating func clear() { self = PodFilter() }

    public func apply(to pods: [Pod], currentUserID: String? = nil) -> [Pod] {
        pods.filter { matches($0, currentUserID: currentUserID) }
    }

    public func matches(_ pod: Pod, currentUserID: String? = nil) -> Bool {
        guard status.matches(pod) else { return false }
        switch project {
        case .any: break
        case .unassigned: if pod.projectName != nil { return false }
        case .named(let name): if pod.projectName != name { return false }
        }
        switch environment {
        case .any: break
        case .withoutEnvironment: if pod.templateId != nil { return false }
        case .named(let id, _): if pod.templateId != id { return false }
        }
        if onlyMine, let currentUserID, pod.userId != currentUserID { return false }
        return matchesSearch(pod)
    }

    /// One field searches pod names, project names and where the pod lives
    /// together, and every word has to land somewhere: typing "acme auth" finds
    /// the auth pod in the acme project, and "on auth" finds its co-located child.
    private func matchesSearch(_ pod: Pod) -> Bool {
        let words = Self.normalized(search)
            .split(separator: " ", omittingEmptySubsequences: true)
            .map(String.init)
        guard !words.isEmpty else { return true }
        let haystack = Self.normalized(
            "\(pod.name) \(pod.projectName ?? "") \(pod.displayLocation) \(pod.hostPodName ?? "")"
        )
        return words.allSatisfy { haystack.contains($0) }
    }

    private static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    /// Says what the list is showing while it is showing something other than your
    /// work. Every part reuses the filter sheet's option labels verbatim, so the
    /// summary reads with the same words the sheet offered.
    public var summary: String {
        var parts: [String] = [status.label]
        switch project {
        case .any: break
        case .unassigned: parts.append("No project")
        case .named(let name): parts.append(name)
        }
        switch environment {
        case .any: break
        case .withoutEnvironment: parts.append("No environment")
        case .named(_, let name): parts.append("from \(name)")
        }
        if onlyMine { parts.append("Only my pods") }
        return parts.joined(separator: " · ")
    }

    public static func projects(in pods: [Pod]) -> [String] {
        Set(pods.compactMap(\.projectName))
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// The environments worth offering: the ones these pods actually came from. An
    /// environment nobody has launched from would only ever filter the list down to
    /// nothing, and a pod whose environment has since been deleted keeps its id —
    /// named by that id, so it stays reachable.
    public static func environments(
        in pods: [Pod], named templates: [PodTemplate]
    ) -> [PodFilterEnvironment] {
        let names = Dictionary(
            templates.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }
        )
        return Set(pods.compactMap(\.templateId))
            .map { .named(id: $0, name: names[$0] ?? String($0.prefix(8))) }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    /// Names hidden lifecycle groups with the same vocabulary as each pod row, so
    /// the list offers them by number instead of leaving someone to wonder where a
    /// pod went.
    public static func statusBreakdown(of pods: [Pod]) -> String? {
        var counts: [PodLifecycle: Int] = [:]
        for pod in pods {
            let lifecycle = PodPresentation(pod: pod).lifecycle
            counts[lifecycle, default: 0] += 1
        }
        let parts = PodLifecycle.allCases.compactMap { lifecycle -> String? in
            guard let count = counts[lifecycle] else { return nil }
            return "\(count) \(lifecycle.label.lowercased())"
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The default is every pod that still needs attention; only archived pods are
/// disclosed separately.
public enum PodFilterStatus: String, CaseIterable, Identifiable, Hashable, Sendable {
    case active
    case archived
    case failed
    case all

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .active: return "Current pods"
        case .archived: return PodLifecycle.archived.label
        case .failed: return PodLifecycle.failed.label
        case .all: return "All pods"
        }
    }

    public func matches(_ pod: Pod) -> Bool {
        let lifecycle = PodPresentation(pod: pod).lifecycle
        switch self {
        case .active: return lifecycle != .archived
        case .archived: return lifecycle == .archived
        case .failed: return lifecycle == .failed
        case .all: return true
        }
    }
}

public enum PodFilterProject: Hashable, Sendable {
    case any
    case unassigned
    case named(String)
}

/// Which environment a pod was launched from. The name travels with the id so the
/// filter can say what it is showing without holding the template list.
public enum PodFilterEnvironment: Hashable, Sendable {
    case any
    /// Pods launched from no environment at all — the built-in default.
    case withoutEnvironment
    case named(id: String, name: String)

    public var label: String {
        switch self {
        case .any: return "All environments"
        case .withoutEnvironment: return "No environment"
        case .named(_, let name): return name
        }
    }

    /// The template this points at, when it points at one.
    public var templateID: String? {
        if case .named(let id, _) = self { return id }
        return nil
    }
}
