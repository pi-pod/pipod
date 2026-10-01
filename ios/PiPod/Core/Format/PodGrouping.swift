import Foundation

/// One machine (or isolated pod) and the pods that belong under it.
///
/// Grouping is a fold on the machine first (`hostPodId`) and the launcher
/// (`parentPodId`) only when there is no host — the same edge the CLI uses. A
/// child whose anchor is not in the incoming list is a root, never hidden.
public struct PodGroup: Identifiable, Hashable, Sendable {
    public let root: Pod
    public let children: [Pod]

    public init(root: Pod, children: [Pod] = []) {
        self.root = root
        self.children = children
    }

    public var id: String { root.id }
    public var members: [Pod] { [root] + children }
    public var hasChildren: Bool { !children.isEmpty }

    /// A failed member pulls the whole group up so it cannot hide under a healthy
    /// host.
    public var needsAttention: Bool {
        members.contains { PodPresentation(pod: $0).lifecycle == .failed }
    }
}

/// Groups `pods` without reordering roots: the first time a pod appears as a root,
/// it keeps that place. Children follow their anchor, even if they arrived earlier
/// in the list.
public func groupPods(_ pods: [Pod]) -> [PodGroup] {
    let present = Set(pods.map(\.id))
    var childrenOf: [String: [Pod]] = [:]
    var roots: [Pod] = []
    for pod in pods {
        guard let anchorID = pod.hostPodId ?? pod.parentPodId, present.contains(anchorID) else {
            roots.append(pod)
            continue
        }
        childrenOf[anchorID, default: []].append(pod)
    }

    // One visual indent under the root: descendants sit beside each other, matching
    // the one-level fold on the machine. Isolated parent/child nests (no host) still
    // appear together rather than as a second tree.
    func descendants(of id: String) -> [Pod] {
        var nested: [Pod] = []
        func walk(_ parentID: String) {
            for child in childrenOf[parentID] ?? [] {
                nested.append(child)
                walk(child.id)
            }
        }
        walk(id)
        return nested
    }

    return roots.map { PodGroup(root: $0, children: descendants(of: $0.id)) }
}

/// Failed groups first, relative order otherwise preserved.
public func attentionFirst(_ groups: [PodGroup]) -> [PodGroup] {
    groups.filter(\.needsAttention) + groups.filter { !$0.needsAttention }
}
