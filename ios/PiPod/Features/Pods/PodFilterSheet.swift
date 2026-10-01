import SwiftUI

/// Every way of narrowing the pod list, in one place.
///
/// It edits a draft and hands it back on Apply: a half-made filter must not keep
/// rearranging the list underneath the sheet. Only dimensions these pods actually
/// have are offered — a filter that could only ever empty the list is not a choice.
struct PodFilterSheet: View {
    let projects: [String]
    let environments: [PodFilterEnvironment]
    let hasUnassignedProject: Bool
    let hasPodsWithoutEnvironment: Bool
    let showsOwnerFilter: Bool
    let apply: (PodFilter) -> Void

    @State private var draft: PodFilter
    @Environment(\.dismiss) private var dismiss

    init(
        filter: PodFilter,
        projects: [String],
        environments: [PodFilterEnvironment],
        hasUnassignedProject: Bool,
        hasPodsWithoutEnvironment: Bool,
        showsOwnerFilter: Bool,
        apply: @escaping (PodFilter) -> Void
    ) {
        self.projects = projects
        self.environments = environments
        self.hasUnassignedProject = hasUnassignedProject
        self.hasPodsWithoutEnvironment = hasPodsWithoutEnvironment
        self.showsOwnerFilter = showsOwnerFilter
        self.apply = apply
        _draft = State(initialValue: filter)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Show") {
                    Picker("Show", selection: $draft.status) {
                        ForEach(PodFilterStatus.allCases) { status in
                            Text(status.label).tag(status)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityIdentifier("podFilter.status")
                }

                if !projects.isEmpty || hasUnassignedProject {
                    Section("Project") {
                        Picker("Project", selection: $draft.project) {
                            Text("All projects").tag(PodFilterProject.any)
                            ForEach(projects, id: \.self) { project in
                                Text(project).tag(PodFilterProject.named(project))
                            }
                            if hasUnassignedProject {
                                Text("No project").tag(PodFilterProject.unassigned)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                        .accessibilityIdentifier("podFilter.project")
                    }
                }

                if !environments.isEmpty || hasPodsWithoutEnvironment {
                    Section("Environment") {
                        Picker("Environment", selection: $draft.environment) {
                            Text(PodFilterEnvironment.any.label)
                                .tag(PodFilterEnvironment.any)
                            ForEach(environments, id: \.self) { environment in
                                Text(environment.label).tag(environment)
                            }
                            if hasPodsWithoutEnvironment {
                                Text(PodFilterEnvironment.withoutEnvironment.label)
                                    .tag(PodFilterEnvironment.withoutEnvironment)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                        .accessibilityIdentifier("podFilter.environment")
                    }
                }

                if showsOwnerFilter {
                    Section {
                        Toggle("Only my pods", isOn: $draft.onlyMine)
                            .accessibilityIdentifier("podFilter.onlyMine")
                    }
                }
            }
            .navigationTitle("Filter pods")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .accessibilityLabel("Cancel pod filters")
                        .accessibilityIdentifier("podFilter.cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Apply") {
                        apply(draft)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .accessibilityLabel("Apply pod filters")
                    .accessibilityIdentifier("podFilter.apply")
                }
            }
        }
    }
}
