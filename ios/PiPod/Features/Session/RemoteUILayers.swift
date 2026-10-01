import SwiftUI

/// A header or footer strip: a full-width band pinned against the transcript.
public struct RemoteUIBand: View {
    private let surface: RemoteUISurface
    private let viewportRows: Int
    private let isHeader: Bool

    public init(surface: RemoteUISurface, viewportRows: Int, isHeader: Bool) {
        self.surface = surface
        self.viewportRows = viewportRows
        self.isHeader = isHeader
    }

    public var body: some View {
        VStack(spacing: 0) {
            if !isHeader { Divider() }
            RemoteUISurfaceView(surface: surface, viewportRows: min(viewportRows, 8))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppColors.bar)
            if isHeader { Divider() }
        }
    }
}

/// Widget-role surfaces stacked directly above or below the composer, in the
/// order the pod opened them.
public struct RemoteUIWidgetStack: View {
    private let surfaces: [RemoteUISurface]
    private let viewportRows: Int

    public init(surfaces: [RemoteUISurface], viewportRows: Int) {
        self.surfaces = surfaces
        self.viewportRows = viewportRows
    }

    public var body: some View {
        if !surfaces.isEmpty {
            VStack(spacing: 0) {
                ForEach(surfaces) { surface in
                    HStack(alignment: .top, spacing: 0) {
                        RemoteUISurfaceView(
                            surface: surface, viewportRows: min(viewportRows, 12)
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                        RemoteUIDismissButton(surface: surface)
                    }
                    .background(AppColors.bar)
                    Divider()
                }
            }
        }
    }
}

/// The editor-role surface, between the transcript and the composer.
///
/// pi's editor component renders its input on the first line and everything
/// else — completions, hints — below it. A real text field replaces that first
/// line, because a phone cannot type into a rendered terminal row; the rest of
/// the lines still render, so those affordances survive.
public struct RemoteUIEditorPanel: View {
    private let surface: RemoteUISurface
    private let viewportRows: Int

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var text = ""
    /// The last pod-requested focus state actually applied. Surfaces repaint on
    /// every pod-side tick, and reapplying per frame would yank focus back from
    /// wherever the person moved it.
    @State private var appliedFocus: Bool?
    /// The last replacement this client sent. A repaint carrying it back is our
    /// own echo, not the pod editing its buffer.
    @State private var lastSentText: String?
    @FocusState private var isFocused: Bool

    public init(surface: RemoteUISurface, viewportRows: Int) {
        self.surface = surface
        self.viewportRows = viewportRows
    }

    private var decoration: [String] {
        surface.lines.count > 1 ? Array(surface.lines.dropFirst()) : []
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            HStack(spacing: 0) {
                TextField("Extension input…", text: $text)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .focused($isFocused)
                    .disabled(surface.readOnly)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(AppColors.bar, in: Capsule())
                    .overlay(Capsule().stroke(AppColors.separator))
                    // The component in the pod decides what Enter means, so it
                    // is forwarded as terminal data rather than handled here.
                    .onSubmit { surface.input("\r") }
                    .accessibilityLabel("Extension input")
                    .accessibilityIdentifier("remoteui.editorField")
                RemoteUIDismissButton(surface: surface)
            }
            .padding(.leading, 16)
            if !decoration.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(decoration.enumerated()), id: \.offset) { _, line in
                            AnsiText(line)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .frame(maxHeight: CGFloat(min(decoration.count, max(viewportRows, 1)))
                    * AnsiCellMetrics.size(for: typeSize).height)
            }
            if surface.readOnly {
                Label("Controlled by another client", systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(StatusTone.caution.color)
                    .padding(.horizontal, 16)
            }
        }
        .padding(.bottom, 6)
        .background(AppColors.card)
        .onAppear {
            text = surface.editorText
            applyPodRequestedFocus()
        }
        // Echoing a value the pod just pushed back at it would fight the
        // component for control of its own buffer.
        .onChange(of: text) { _, value in
            guard value != surface.editorText else { return }
            lastSentText = value
            surface.setText(value)
        }
        .onChange(of: surface.editorText) { _, value in
            // While the field has focus the person's buffer wins. The pod
            // repaints on a timer, so its echo of our own replacement always
            // arrives a few keystrokes late, and adopting it mid-sentence
            // rewrites what was just typed. Unfocused, the pod is authoritative.
            guard !isFocused, value != lastSentText, value != text else { return }
            text = value
        }
        .onChange(of: surface.frame.focused) { _, _ in applyPodRequestedFocus() }
        .onChange(of: surface.readOnly) { _, readOnly in
            if readOnly { isFocused = false }
        }
    }

    /// The pod explicitly asking for the editor (`focused: true`) focuses the
    /// real text input, which is what raises the software keyboard. Anything
    /// else leaves focus alone.
    private func applyPodRequestedFocus() {
        guard !surface.readOnly, let want = surface.frame.focused, appliedFocus != want
        else { return }
        appliedFocus = want
        isFocused = want
    }
}

/// Custom-role overlay surfaces floating over the transcript.
public struct RemoteUIOverlayLayer: View {
    private let surfaces: [RemoteUISurface]
    private let viewportRows: Int

    @Environment(\.dynamicTypeSize) private var typeSize

    public init(surfaces: [RemoteUISurface], viewportRows: Int) {
        self.surfaces = surfaces
        self.viewportRows = viewportRows
    }

    public var body: some View {
        GeometryReader { proxy in
            ForEach(surfaces) { surface in
                overlay(surface, in: proxy.size)
            }
        }
    }

    private func overlay(_ surface: RemoteUISurface, in size: CGSize) -> some View {
        let options = surface.overlayOptions
        let cell = AnsiCellMetrics.size(for: typeSize)
        let width = options?.width
            .map { $0.resolve(total: size.width / cell.width) * cell.width }
            ?? min(size.width - 32, 520)
        let minWidth = options?.minWidth.map { $0 * cell.width } ?? 0
        let maxHeight = options?.maxHeight
            .map { $0.resolve(total: size.height / cell.height) * cell.height }
            ?? size.height * 0.7
        let margin = options?.margin ?? RemoteUIMargin()

        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                RemoteUISurfaceView(surface: surface, viewportRows: viewportRows)
                    .frame(maxWidth: .infinity, alignment: .leading)
                RemoteUIDismissButton(surface: surface)
            }
        }
        .frame(width: max(width, minWidth))
        .frame(maxHeight: maxHeight)
        .background(AppColors.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppColors.separator))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        .position(position(surface, in: size, width: max(width, minWidth), margin: margin))
        // A non-capturing overlay is decoration: it must not swallow a tap meant
        // for the transcript underneath it.
        .allowsHitTesting(!(options?.nonCapturing ?? false))
    }

    private func position(
        _ surface: RemoteUISurface, in size: CGSize, width: CGFloat, margin: RemoteUIMargin
    ) -> CGPoint {
        let options = surface.overlayOptions
        let cell = AnsiCellMetrics.size(for: typeSize)
        var x = size.width / 2
        var y = size.height / 2

        if let column = options?.col {
            x = column.resolve(total: size.width / cell.width) * cell.width + width / 2
        } else {
            switch options?.anchor {
            case "left", "topLeft", "bottomLeft":
                x = width / 2 + margin.left * cell.width
            case "right", "topRight", "bottomRight":
                x = size.width - width / 2 - margin.right * cell.width
            default:
                break
            }
        }
        if let row = options?.row {
            y = row.resolve(total: size.height / cell.height) * cell.height
        } else {
            switch options?.anchor {
            case "top", "topLeft", "topRight":
                y = size.height * 0.25 + margin.top * cell.height
            case "bottom", "bottomLeft", "bottomRight":
                y = size.height * 0.75 - margin.bottom * cell.height
            default:
                break
            }
        }
        return CGPoint(
            x: x + (options?.offsetX ?? 0) * cell.width,
            y: y + (options?.offsetY ?? 0) * cell.height
        )
    }
}
