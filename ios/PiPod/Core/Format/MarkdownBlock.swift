import Foundation

/// Block-level markdown produced by `MarkdownBlock.parse`.
///
/// Fenced code, headings, list items, quotes, pipe tables, and leftover
/// paragraphs. Inline markup stays in the block text for the rendering pass,
/// which hands it to `AttributedString(markdown:)`.
public enum MarkdownBlock: Hashable, Sendable {
    case paragraph(String)
    case heading(level: Int, content: String)
    case listItem(marker: String, content: String)
    case quote(String)
    case code(String)
    case table(rows: String)

    public static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var codeLines: [String] = []
        var tableLines: [String] = []
        var inCode = false

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph = []
        }

        func flushTable() {
            guard !tableLines.isEmpty else { return }
            blocks.append(.table(rows: tableLines.joined(separator: "\n")))
            tableLines = []
        }

        for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                if inCode {
                    blocks.append(.code(codeLines.joined(separator: "\n")))
                    codeLines = []
                    inCode = false
                } else {
                    flushParagraph()
                    flushTable()
                    inCode = true
                }
                continue
            }
            if inCode {
                // Indentation inside a fence is content, not layout.
                codeLines.append(line)
                continue
            }

            if trimmed.hasPrefix("|") {
                flushParagraph()
                tableLines.append(trimmed)
                continue
            }
            flushTable()

            if trimmed.isEmpty {
                flushParagraph()
                continue
            }
            if let heading = parseHeading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                continue
            }
            if let item = parseListItem(trimmed) {
                flushParagraph()
                blocks.append(item)
                continue
            }
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                blocks.append(.quote(String(trimmed.dropFirst(trimmed == ">" ? 1 : 2))))
                continue
            }

            paragraph.append(line)
        }

        // An unterminated fence still shows as code rather than vanishing.
        if inCode, !codeLines.isEmpty {
            blocks.append(.code(codeLines.joined(separator: "\n")))
        }
        flushTable()
        flushParagraph()
        return blocks
    }

    private static func parseHeading(_ line: String) -> MarkdownBlock? {
        guard line.hasPrefix("#") else { return nil }
        let level = line.prefix(while: { $0 == "#" }).count
        guard level <= 6 else { return nil }
        let content = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return .heading(level: level, content: content)
    }

    private static func parseListItem(_ line: String) -> MarkdownBlock? {
        for bullet in ["- ", "* ", "+ "] where line.hasPrefix(bullet) {
            return .listItem(marker: "•", content: String(line.dropFirst(bullet.count)))
        }
        // Numbered items keep their number so ordered steps read as ordered.
        guard let dot = line.firstIndex(of: ".") else { return nil }
        let position = line.distance(from: line.startIndex, to: dot)
        guard position <= 3, line[line.startIndex..<dot].allSatisfy(\.isNumber) else { return nil }
        let afterDot = line.index(after: dot)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        return .listItem(
            marker: String(line[line.startIndex...dot]),
            content: String(line[line.index(after: afterDot)...])
        )
    }
}
