package com.pipod.app.core.format

/**
 * Block-level markdown produced by [MarkdownBlock.parse].
 *
 * Port of the iOS `MarkdownBlock` enum: fenced code, headings, list items,
 * quotes, pipe tables, and leftover paragraphs. Inline markup is left in the
 * block text for a later rendering pass.
 */
sealed interface MarkdownBlock {

    companion object {
        fun parse(text: String): List<MarkdownBlock> {
            val blocks = mutableListOf<MarkdownBlock>()
            val paragraph = mutableListOf<String>()
            val codeLines = mutableListOf<String>()
            val tableLines = mutableListOf<String>()
            var inCode = false

            fun flushParagraph() {
                if (paragraph.isEmpty()) return
                blocks.add(MarkdownParagraph(paragraph.joinToString("\n")))
                paragraph.clear()
            }

            fun flushTable() {
                if (tableLines.isEmpty()) return
                blocks.add(MarkdownTable(tableLines.joinToString("\n")))
                tableLines.clear()
            }

            for (line in text.split("\n")) {
                val trimmed = trimWhitespaces(line)

                if (trimmed.startsWith("```")) {
                    if (inCode) {
                        blocks.add(MarkdownCode(codeLines.joinToString("\n")))
                        codeLines.clear()
                        inCode = false
                    } else {
                        flushParagraph()
                        flushTable()
                        inCode = true
                    }
                    continue
                }
                if (inCode) {
                    codeLines.add(line)
                    continue
                }

                if (trimmed.startsWith("|")) {
                    flushParagraph()
                    tableLines.add(trimmed)
                    continue
                }
                flushTable()

                if (trimmed.isEmpty()) {
                    flushParagraph()
                    continue
                }

                val heading = parseHeading(trimmed)
                if (heading != null) {
                    flushParagraph()
                    blocks.add(heading)
                    continue
                }
                val item = parseListItem(trimmed)
                if (item != null) {
                    flushParagraph()
                    blocks.add(item)
                    continue
                }
                if (trimmed.startsWith("> ") || trimmed == ">") {
                    flushParagraph()
                    blocks.add(MarkdownQuote(trimmed.substring(if (trimmed == ">") 1 else 2)))
                    continue
                }

                paragraph.add(line)
            }

            // An unterminated fence still shows as code rather than vanishing.
            if (inCode && codeLines.isNotEmpty()) {
                blocks.add(MarkdownCode(codeLines.joinToString("\n")))
            }
            flushTable()
            flushParagraph()
            return blocks
        }

        /**
         * Swift `trimmingCharacters(in: .whitespaces)`: Unicode Zs + TAB.
         * [String.trim] also strips CR/LF, which Swift's `.whitespaces` does not.
         */
        private fun trimWhitespaces(value: String): String {
            var start = 0
            var end = value.length
            while (start < end && isWhitespace(value[start])) start += 1
            while (end > start && isWhitespace(value[end - 1])) end -= 1
            if (start == 0 && end == value.length) return value
            return value.substring(start, end)
        }

        private fun isWhitespace(unit: Char): Boolean {
            val code = unit.code
            if (code == 0x09 || code == 0x20) return true
            if (code == 0x00A0 || code == 0x1680) return true
            if (code in 0x2000..0x200A) return true
            return code == 0x202F || code == 0x205F || code == 0x3000
        }

        private fun parseHeading(line: String): MarkdownHeading? {
            if (!line.startsWith("#")) return null
            var level = 0
            while (level < line.length && line[level].code == 0x23) level += 1
            if (level > 6) return null
            val content = trimWhitespaces(line.substring(level))
            if (content.isEmpty()) return null
            return MarkdownHeading(level = level, content = content)
        }

        private fun parseListItem(line: String): MarkdownListItem? {
            for (bullet in listOf("- ", "* ", "+ ")) {
                if (line.startsWith(bullet)) {
                    return MarkdownListItem(marker = "•", content = line.substring(bullet.length))
                }
            }
            // Numbered items keep their number so ordered steps read as ordered.
            val dotIndex = line.indexOf('.')
            if (dotIndex >= 0 &&
                dotIndex <= 3 &&
                allNumbers(line.substring(0, dotIndex)) &&
                dotIndex + 1 < line.length &&
                line[dotIndex + 1].code == 0x20
            ) {
                return MarkdownListItem(
                    marker = line.substring(0, dotIndex + 1),
                    content = line.substring(dotIndex + 2),
                )
            }
            return null
        }

        /** Swift `allSatisfy(\.isNumber)` is true for an empty prefix. */
        private fun allNumbers(value: String): Boolean =
            value.isEmpty() || value.all { Character.isDigit(it) || isNumeric(it) }

        private fun isNumeric(character: Char): Boolean =
            when (Character.getType(character).toByte()) {
                Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
                else -> false
            }
    }
}

data class MarkdownParagraph(val content: String) : MarkdownBlock

data class MarkdownHeading(val level: Int, val content: String) : MarkdownBlock

data class MarkdownListItem(val marker: String, val content: String) : MarkdownBlock

data class MarkdownQuote(val content: String) : MarkdownBlock

data class MarkdownCode(val content: String) : MarkdownBlock

data class MarkdownTable(val rows: String) : MarkdownBlock
