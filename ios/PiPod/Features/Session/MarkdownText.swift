import SwiftUI

/// pi's markdown replies, as styled blocks.
///
/// Block structure comes from `MarkdownBlock`; inline markup is handed to
/// `AttributedString(markdown:)`, which already implements CommonMark's inline
/// rules — including the one that matters most here, that `some_function_name`
/// is not emphasis. Anything that fails to parse falls back to the literal text,
/// so a reply never renders as nothing.
public struct MarkdownText: View {
    private let text: String

    /// The link a tap is asking to open, held until the reader has seen where it
    /// actually goes.
    @State private var pendingLink: URL?

    public init(_ text: String) { self.text = text }

    public var body: some View {
        let blocks = MarkdownBlock.parse(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Every link in this subtree is agent-authored. The label is arbitrary
        // text the model chose, so the destination is shown before anything is
        // opened; nothing here dials a URL on a single tap.
        .environment(\.openURL, OpenURLAction { url in
            // Belt and braces: `inline` already strips the link attribute from
            // anything that is not web or mail, so nothing here should be
            // tappable in the first place.
            guard MarkdownText.isOpenable(url) else { return .discarded }
            pendingLink = url
            return .handled
        })
        .confirmationDialog(
            MarkdownText.confirmTitle(pendingLink),
            isPresented: Binding(
                get: { pendingLink != nil },
                set: { if !$0 { pendingLink = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingLink
        ) { url in
            // Deliberately not the `openURL` environment action: this subtree's
            // copy of it is the handler above, and routing the confirmation
            // back into it would loop.
            Button("Open in browser") { UIApplication.shared.open(url) }
            Button("Copy link") { UIPasteboard.general.string = url.absoluteString }
            Button("Cancel", role: .cancel) {}
        } message: { url in
            Text(MarkdownText.confirmMessage(url))
        }
    }

    /// The host, big: it is the one part of a URL that says who is being
    /// talked to, and the one part a deceptive label is trying to hide.
    static func confirmTitle(_ url: URL?) -> String {
        guard let url else { return "Open link?" }
        if let host = url.host(), !host.isEmpty { return "Open \(host)?" }
        if url.scheme?.lowercased() == "mailto" {
            return "Email \(url.absoluteString.dropFirst("mailto:".count))?"
        }
        return "Open link?"
    }

    /// The whole address under it: the host answers "who", this answers "what",
    /// and pi wrote both.
    static func confirmMessage(_ url: URL) -> String {
        """
        \(url.absoluteString)

        This link came from pi’s reply, not from pi pod.
        """
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .code(let content):
            MonospacePanel(text: content, opacity: 0.6, copyLabel: "Copy code")

        case .heading(let level, let content):
            // Headings keep a long reply scannable: H1 reads as a title, H2/H3
            // step down from it, all clearly above body copy.
            Text(MarkdownText.inline(content))
                .font(level == 1 ? .title2 : (level == 2 ? .title3 : .headline))
                .textSelection(.enabled)
                .padding(.top, 2)

        case .listItem(let marker, let content):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(AppColors.secondaryLabel)
                Text(MarkdownText.inline(content))
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .quote(let content):
            HStack(alignment: .top, spacing: 8) {
                Capsule()
                    .fill(AppColors.secondaryLabel.opacity(0.5))
                    .frame(width: 3)
                Text(MarkdownText.inline(content))
                    .font(.callout)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .table(let rows):
            // No table layout here either: aligned monospace beats a paragraph
            // of raw pipes.
            MonospacePanel(text: rows, opacity: 0.4, copyLabel: nil)

        case .paragraph(let content):
            Text(MarkdownText.inline(content))
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Schemes an agent-authored link is allowed to carry.
    ///
    /// Everything in a reply is written by a model, which may be repeating text
    /// from a repository, a web page or a tool result — so a link here is
    /// untrusted input that happens to be rendered by a trusted app. `pipod://`
    /// would drive this app's own deep links from a tap on arbitrary text;
    /// `file://` reaches the sandbox; `javascript:` and `data:` are the classic
    /// smuggled payloads. Only the three schemes that mean "somewhere else, in
    /// another app, visibly" survive.
    static let openableSchemes: Set<String> = ["http", "https", "mailto"]

    static func isOpenable(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return openableSchemes.contains(scheme)
    }

    /// Inline markdown, preserving the whitespace a transcript depends on.
    /// Falls back to the literal text when parsing fails.
    ///
    /// A link whose scheme is not openable keeps its text and loses its link: it
    /// reads as the words pi wrote, with no way to tap it into an action nobody
    /// asked for.
    static func inline(_ content: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.allowsExtendedAttributes = true
        guard var attributed = try? AttributedString(markdown: content, options: options) else {
            return AttributedString(content)
        }
        for run in attributed.runs where run.inlinePresentationIntent?.contains(.code) == true {
            attributed[run.range].font = .system(.callout, design: .monospaced)
            attributed[run.range].backgroundColor = AppColors.fill
        }
        // Ranges are collected before anything is written: removing an
        // attribute can merge neighbouring runs, and mutating the value being
        // iterated is how that turns into a crash. Attribute-only edits never
        // move characters, so the collected ranges stay valid.
        let links = attributed.runs.compactMap { run -> (Range<AttributedString.Index>, URL)? in
            run.link.map { (run.range, $0) }
        }
        for (range, link) in links {
            guard isOpenable(link) else {
                attributed[range].link = nil
                continue
            }
            attributed[range].foregroundColor = AppColors.accent
            attributed[range].underlineStyle = .single
        }
        return attributed
    }
}

/// A code or table block: monospaced, horizontally scrollable, with a Copy
/// action large enough to hit. Copying a command is the single most common thing
/// a person does with a code block, and a long-press-only affordance hides it.
struct MonospacePanel: View {
    let text: String
    let opacity: Double
    let copyLabel: String?

    @State private var copied = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: true) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    // Code is a grid: let it run as wide as it needs and scroll,
                    // rather than wrapping or truncating a command mid-flag.
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.top, copyLabel == nil ? 10 : 44)
                    .padding(.bottom, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AppColors.fill.opacity(opacity), in: RoundedRectangle(cornerRadius: 8))

            if let copyLabel {
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        copied = false
                    }
                } label: {
                    Label(
                        copied ? "Copied" : "Copy",
                        systemImage: copied ? "checkmark" : "doc.on.doc"
                    )
                    .labelStyle(.titleAndIcon)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(AppColors.accent)
                .accessibilityLabel(copyLabel)
                .accessibilityIdentifier("markdown.copyCode")
            }
        }
    }
}

#Preview {
    ScrollView {
        MarkdownText(
            """
            # Heading one
            Some **bold**, some *italic*, some `inline_code`, and a \
            [link](https://pipod.dev). Note that some_function_name stays plain.

            1. First step
            2. Second step
            - A bullet

            > A quoted aside

            ```
            swift build --configuration release
            ```

            | a | b |
            | - | - |
            | 1 | 2 |
            """
        )
        .padding()
    }
}
