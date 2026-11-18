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
