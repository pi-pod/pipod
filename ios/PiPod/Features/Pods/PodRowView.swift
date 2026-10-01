import SwiftUI

/// One pod in the list: what it is, how it is, and what it is doing.
struct PodRowView: View {
    let pod: Pod
    let depth: Int
    let showsLocation: Bool
    let showsOwner: Bool

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var indent: CGFloat = 16

    private var presentation: PodPresentation { PodPresentation(pod: pod) }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if depth > 0 {
                Spacer().frame(width: indent * CGFloat(depth))
            }
            PodStateIcon(presentation: presentation)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                heading
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AppColors.secondaryLabel)
                if showsStorageDetail, let detail = presentation.statusDetail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
                if showsOwner {
                    Label("Another organization member", systemImage: "person.fill")
                        .font(.caption)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
                if let reason = presentation.userFacingReason {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(AppColors.destructive)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    /// The name truncates before the chip rather than running beneath it; at an
    /// accessibility size there is no room for both, so the chip moves below.
    @ViewBuilder
    private var heading: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                Text(pod.name).font(.headline)
                StatusChip(presentation.statusLabel, tone: presentation.tone)
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(pod.name)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                StatusChip(presentation.statusLabel, tone: presentation.tone)
                    .fixedSize()
            }
        }
    }

    /// Storage copy belongs to a pod that is only asleep: a failed or starting pod
    /// has something more urgent to say in the same space.
    private var showsStorageDetail: Bool {
        presentation.lifecycle == .asleep || pod.capacityWait?.isWaiting == true
            || presentation.lifecycle == .archived
    }

    private var activity: String {
        guard let relative = Format.relative(pod.lastActivityAt ?? pod.createdAt) else {
            return "no activity yet"
        }
        return "last used \(relative)"
    }

    private var subtitle: String {
        var parts: [String] = []
        if let project = pod.projectName { parts.append(project) }
        parts.append(activity)
        if showsLocation || pod.isHostChild { parts.append(pod.displayLocation) }
        return parts.joined(separator: " · ")
    }

    /// One fixed order in every state — name, status, location, provider, project,
    /// activity — so the same pod never reads two different ways.
    private var accessibilityLabel: String {
        var parts: [String] = ["Open pod \(pod.name)", presentation.statusLabel]
        parts.append(pod.displayLocation)
        if pod.provider != pod.displayLocation, !pod.provider.isEmpty {
            parts.append(pod.provider)
        }
        if let project = pod.projectName { parts.append(project) }
        parts.append(activity)
        if showsStorageDetail, let detail = presentation.statusDetail {
            parts.append(detail)
        }
        if showsOwner { parts.append("Owned by another organization member") }
        if let reason = presentation.userFacingReason { parts.append(reason) }
        return parts.joined(separator: ", ")
    }
}

/// The lifecycle glyph. A transitional state pulses, because a still icon reads as
/// settled — and holds still for anyone who asked the system to stop animating.
struct PodStateIcon: View {
    let presentation: PodPresentation
    var size: CGFloat?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isDim = false

    var body: some View {
        Image(systemName: presentation.systemImage)
            .font(size.map { .system(size: $0) } ?? .body)
            .foregroundStyle(presentation.tone.color)
            .opacity(isDim ? 0.35 : 1)
            .animation(
                pulses
                    ? .easeInOut(duration: 0.85).repeatForever(autoreverses: true) : .default,
                value: isDim
            )
            .onAppear { isDim = pulses }
            .onChange(of: presentation.isTransitional) { _, _ in isDim = pulses }
            .accessibilityHidden(true)
    }

    private var pulses: Bool { presentation.isTransitional && !reduceMotion }
}
