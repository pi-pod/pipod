import SwiftUI

/// The measured monospace cell the pod is told about.
///
/// Extension components are laid out in the pod against a terminal grid, so the
/// host has to report how many columns and rows it can actually show. The cell
/// is a function of Dynamic Type, because the lines are drawn in a text style
/// that scales with it: measuring once at launch told the pod a grid that was
/// right for one text size and wrong for every other, and a TUI drawing box
/// borders to a width the reader does not have wraps into rubble.
///
/// Each size is measured once and kept: a repaint arrives many times a second
/// and must not re-measure text on every frame.
enum AnsiCellMetrics {
    private static let cache = SizeCache()

    static func size(for typeSize: DynamicTypeSize) -> CGSize {
        cache.size(for: typeSize)
    }

    static func columns(in width: CGFloat, typeSize: DynamicTypeSize) -> Int {
        max(1, Int((width / size(for: typeSize).width).rounded(.down)))
    }

    static func rows(in height: CGFloat, typeSize: DynamicTypeSize) -> Int {
        max(1, Int((height / size(for: typeSize).height).rounded(.down)))
    }

    /// SwiftUI's scale and UIKit's are the same ladder under two names, and the
    /// font has to be asked for in UIKit's.
    static func contentSizeCategory(_ typeSize: DynamicTypeSize) -> UIContentSizeCategory {
        switch typeSize {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }

    private static func measure(_ typeSize: DynamicTypeSize) -> CGSize {
        let traits = UITraitCollection(preferredContentSizeCategory: contentSizeCategory(typeSize))
        let point = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits).pointSize
        let font = UIFont.monospacedSystemFont(ofSize: point, weight: .regular)
        let width = ("M" as NSString).size(withAttributes: [.font: font]).width
        return CGSize(width: max(width, 1), height: max(font.lineHeight, 1))
    }

    private final class SizeCache: @unchecked Sendable {
        private let lock = NSLock()
        private var sizes: [DynamicTypeSize: CGSize] = [:]

        func size(for typeSize: DynamicTypeSize) -> CGSize {
            lock.withLock {
                if let cached = sizes[typeSize] { return cached }
                let measured = AnsiCellMetrics.measure(typeSize)
                sizes[typeSize] = measured
                return measured
            }
        }
    }
}

/// The raw terminal data one edit of the compact input represents.
///
/// A TUI is driven by keystrokes, not by a finished string, so the field
/// forwards what changed: appended characters as themselves, and a backspace as
/// the DEL byte a terminal would have seen.
enum RemoteUITypedInput {
    static func delta(from old: String, to new: String) -> String {
        let common = old.commonPrefix(with: new)
        let removed = old.count - common.count
        return String(repeating: "\u{7f}", count: removed) + new.dropFirst(common.count)
    }

    /// Whether tapping this surface should open the compact input.
    ///
    /// A read-only surface belongs to another client and refuses input; the
    /// editor role has a real text field of its own.
    static func isOffered(readOnly: Bool, role: RemoteUIRole) -> Bool {
        !readOnly && role != .editor
    }
}

/// One pod-side extension surface: its rendered lines, and the input path back.
///
/// Repainting must never move focus. Nothing here calls `focused` as a side
/// effect of new lines arriving — the surface takes keyboard focus only when the
/// person taps it — so a pod-side timer tick cannot pull the caret out of the
/// composer mid-sentence.
public struct RemoteUISurfaceView: View {
    private let surface: RemoteUISurface
    private let viewportRows: Int

    @Environment(\.dynamicTypeSize) private var typeSize
    @FocusState private var keyboardFocused: Bool
    @FocusState private var typingFocused: Bool
    /// Open only after a deliberate tap. A phone has no hardware keyboard, so
    /// focus alone would have been an affordance that does nothing.
    @State private var isTyping = false
    @State private var typed = ""
    @State private var measured: CGSize = .zero

    public init(surface: RemoteUISurface, viewportRows: Int) {
        self.surface = surface
        self.viewportRows = viewportRows
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if surface.readOnly {
                Label("Controlled by another client", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(StatusTone.caution.color)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("remoteui.readOnly")
            }
            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(surface.lines.enumerated()), id: \.offset) { _, line in
                        AnsiText(line)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .frame(maxHeight: maxHeight)
            if isTyping { typingField }
        }
        .background(
            GeometryReader { proxy in
                Color.clear.onChange(of: proxy.size, initial: true) { _, size in
                    measured = size
                    reportGrid()
                }
            }
        )
        // The cell is a function of Dynamic Type, so a text-size change resizes
        // the pod's grid even though the view's own bounds did not move.
        .onChange(of: typeSize) { _, _ in reportGrid() }
        .contentShape(Rectangle())
        .onTapGesture {
            // Focus is a deliberate act. Only this takes it.
            guard !surface.readOnly else { return }
            keyboardFocused = true
            guard RemoteUITypedInput.isOffered(readOnly: surface.readOnly, role: surface.role)
            else { return }
            isTyping = true
            typingFocused = true
        }
        .focusable(!surface.readOnly)
        .focused($keyboardFocused)
        .onKeyPress { press in
            guard !surface.readOnly,
                  let data = RemoteUIKeys.encode(press)
            else { return .ignored }
            surface.input(data)
            return .handled
        }
        .onChange(of: surface.readOnly) { _, readOnly in
            if readOnly { closeTyping() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier("remoteui.surface")
    }

    /// A compact line that forwards what was typed as terminal data, so a menu
    /// or prompt drawn by the pod can actually be answered from a phone.
    private var typingField: some View {
        HStack(spacing: 8) {
            TextField("Type into this panel…", text: $typed)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.send)
                .focused($typingFocused)
                .font(.system(.footnote, design: .monospaced))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(AppColors.bar, in: Capsule())
                .overlay(Capsule().stroke(AppColors.separator))
                // The component in the pod decides what Enter means, so it goes
                // as terminal data rather than being handled here.
                .onSubmit { surface.input("\r") }
                .onChange(of: typed) { old, new in
                    let delta = RemoteUITypedInput.delta(from: old, to: new)
                    guard !delta.isEmpty else { return }
                    surface.input(delta)
                }
                .accessibilityLabel("Type into \(surface.role.rawValue) panel")
                .accessibilityIdentifier("remoteui.typedInput")
            Button {
                surface.input("\r")
            } label: {
                Image(systemName: "return")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.accent)
            .accessibilityLabel("Send Enter to \(surface.role.rawValue) panel")
            .accessibilityIdentifier("remoteui.typedReturn")
            Button {
                closeTyping()
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(AppColors.secondaryLabel)
            .accessibilityLabel("Stop typing into \(surface.role.rawValue) panel")
            .accessibilityIdentifier("remoteui.typedDismiss")
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    private func closeTyping() {
        isTyping = false
        typingFocused = false
        typed = ""
    }

    private func reportGrid() {
        guard measured.width > 0, measured.height > 0 else { return }
        surface.resize(
            width: AnsiCellMetrics.columns(in: measured.width, typeSize: typeSize),
            height: min(
                viewportRows, AnsiCellMetrics.rows(in: measured.height, typeSize: typeSize)
            )
        )
    }

    /// A surface never asks for more rows than the session view has.
    private var maxHeight: CGFloat {
        let requested = min(max(surface.lines.count, 1), max(viewportRows, 1))
        return CGFloat(requested) * AnsiCellMetrics.size(for: typeSize).height + 8
    }

    private var accessibilityLabel: String {
        let body = surface.lines.map(Ansi.strip).joined(separator: ". ")
        let role = surface.role.rawValue
        return surface.readOnly
            ? "\(role) panel, controlled by another client. \(body)"
            : "\(role) panel. \(body)"
    }
}

/// A dismiss control for a surface the person can close locally.
struct RemoteUIDismissButton: View {
    let surface: RemoteUISurface

    var body: some View {
        Button {
            surface.close()
        } label: {
            Image(systemName: "xmark.circle.fill")
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppColors.secondaryLabel)
        .accessibilityLabel("Dismiss \(surface.role.rawValue) panel")
        .accessibilityIdentifier("remoteui.dismiss")
    }
}
