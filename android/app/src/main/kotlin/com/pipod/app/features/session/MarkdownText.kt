package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.pipod.app.core.format.MarkdownBlock
import com.pipod.app.core.format.MarkdownCode
import com.pipod.app.core.format.MarkdownHeading
import com.pipod.app.core.format.MarkdownListItem
import com.pipod.app.core.format.MarkdownParagraph
import com.pipod.app.core.format.MarkdownQuote
import com.pipod.app.core.format.MarkdownTable
import com.pipod.app.core.format.SafeExternalUrl
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppSelectable
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.LocalAppDialogHost
import com.pipod.app.ui.LocalAppToastHost
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.AppColors
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * Renders pi's markdown replies as styled blocks with no external dependency: fenced code
 * becomes monospaced panels with a copy action, headings and list markers are handled line
 * by line, and everything else gets inline markdown (bold, italics, `code`, links) — so
 * `**bold**` and ``` fences never reach the screen as raw syntax.
 *
 * Ported from `pi-pod-flutter/lib/features/session/markdown_text.dart`. Swift gets inline
 * parsing free from `AttributedString(markdown:)` and Android has no equivalent either, so
 * [MarkdownInlineToken] below is a deliberate, bounded reimplementation of only the inline
 * syntax pi actually emits.
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    parse: (String) -> List<MarkdownBlock> = MarkdownBlock::parse,
) {
    // Keyed on the text, not recomputed per composition: a streaming reply
    // recomposes its row on every delta, and re-parsing the whole answer each
    // time is quadratic in the length of the answer. [parse] is a seam so a
    // test can count how often that actually happens.
    val blocks = remember(text) { parse(text) }
    Column(
        modifier = modifier.testTag("markdown-text"),
        horizontalAlignment = Alignment.Start,
    ) {
        blocks.forEachIndexed { index, block ->
            if (index > 0) Spacer(Modifier.height(8.dp))
            MarkdownBlockContent(block)
        }
    }
}

@Composable
private fun MarkdownBlockContent(block: MarkdownBlock) {
    val colors = appColors
    when (block) {
        is MarkdownCode -> MonospacePanel(
            text = block.content,
            opacity = 0.6f,
            copyLabel = "Copy code",
        )

        is MarkdownHeading -> {
            // Headings keep the transcript scannable: H1 reads as a title,
            // H2/H3 step down from it, all clearly above body copy.
            val headingStyle = when (block.level) {
                1 -> MaterialTheme.typography.headlineMedium
                2 -> MaterialTheme.typography.headlineSmall
                else -> MaterialTheme.typography.titleLarge
            }
            MarkdownInline(
                content = block.content,
                modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
                style = headingStyle,
            )
        }

        is MarkdownListItem -> Row(verticalAlignment = Alignment.Top) {
            Text(
                text = block.marker,
                // Tabular figures keep "9." and "10." on the same left edge, so an
                // ordered list does not shuffle sideways as it counts up.
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontFeatureSettings = "tnum",
                    color = colors.secondaryLabel,
                ),
            )
            Spacer(Modifier.width(6.dp))
            MarkdownInline(block.content, modifier = Modifier.weight(1f, fill = false))
        }

        is MarkdownQuote -> Row(verticalAlignment = Alignment.Top) {
            Box(
                Modifier
                    .size(width = 3.dp, height = 20.dp)
                    .background(
                        color = colors.secondaryLabel.copy(alpha = 0.5f),
                        shape = RoundedCornerShape(1.5.dp),
                    ),
            )
            Spacer(Modifier.width(8.dp))
            MarkdownInline(
                content = block.content,
                modifier = Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.bodyMedium.copy(color = colors.secondaryLabel),
            )
        }

        // There is no table support here either; aligned monospace beats a paragraph of
        // raw pipes.
        is MarkdownTable -> MonospacePanel(text = block.rows, opacity = 0.4f, copyLabel = null)

        is MarkdownParagraph -> MarkdownInline(block.content)
    }
}

/**
 * A fenced block or a table: monospace on a tinted panel that scrolls sideways rather than
 * wrapping, because a wrapped command line stops being a command line.
 *
 * @param copyLabel names the copy button, and its absence is what says a table has no copy
 *   action at all.
 */
@Composable
private fun MonospacePanel(text: String, opacity: Float, copyLabel: String?) {
    val colors = appColors
    val clipboard = LocalClipboardManager.current
    val toastHost = LocalAppToastHost.current
    val scope = rememberCoroutineScope()
    val scrollState = rememberScrollState()
    val copy: () -> Unit = {
        clipboard.setText(AnnotatedString(text))
        scope.launch { showAppToast(toastHost, "Copied") }
    }

    Box(modifier = Modifier.fillMaxWidth().testTag("markdown-code-panel")) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(colors.fill.copy(alpha = opacity))
                // No long-press-to-copy here: it is the same gesture text
                // selection starts with, and a raw pointer handler above the
                // text wins it. The named copy button beside the panel does the
                // job without fighting the selection.
                .horizontalScroll(scrollState),
        ) {
            AppSelectableText(
                text = text,
                // The top inset is the copy button's own 48dp target: the first line of
                // code has to start below it, not under it.
                modifier = Modifier.padding(
                    start = 8.dp,
                    top = if (copyLabel == null) 8.dp else AppButtonDefaults.MinTouchTarget,
                    end = 8.dp,
                    bottom = 8.dp,
                ),
                style = MonospaceTextStyle,
            )
        }
        if (copyLabel != null) {
            AppIconButton(
                icon = AppIcons.copy,
                onClick = copy,
                semanticsLabel = copyLabel,
                modifier = Modifier.align(Alignment.TopEnd).testTag("markdown-copy"),
                dimension = AppButtonDefaults.MinTouchTarget,
            )
        }
    }
}

/**
 * Inline markdown: `**bold**`, `*italic*`/`_italic_`, `` `code` `` and `[text](url)`.
 * Deliberately not a full markdown implementation — block structure is already handled
 * by [MarkdownBlock], and anything unrecognised is shown verbatim rather than eaten.
 */
@Composable
fun MarkdownInline(
    content: String,
    modifier: Modifier = Modifier,
    style: TextStyle? = null,
    parse: (String) -> List<MarkdownInlineToken> = MarkdownInlineToken::parse,
) {
    val colors = appColors
    val base = style ?: MaterialTheme.typography.bodyMedium
    // Same reason as [MarkdownText]: one parse per distinct run of text, not
    // one per frame of a streaming turn.
    val tokens = remember(content) { parse(content) }
    if (tokens.isEmpty()) {
        // The parser never yields this for non-empty input, but a transcript
        // row must render something rather than fail if that ever changes.
        AppSelectableText(content, modifier = modifier, style = base)
        return
    }
    if (tokens.all { !it.bold && !it.italic && !it.code && it.link == null }) {
        // Most transcript lines carry no marks at all, and plain text keeps the
        // platform's own selection behaviour instead of a rich-text imitation.
        AppSelectableText(
            text = tokens.joinToString(separator = "") { it.text },
            modifier = modifier,
            style = base,
        )
        return
    }

    // Only reached for text that carries marks, so a plain transcript line
    // costs neither the listener nor the dialog host behind it.
    val onLinkTapped = rememberMarkdownLinkListener()
    val annotated = remember(tokens, base, colors, onLinkTapped) {
        markdownAnnotatedString(tokens, base, colors, onLinkTapped)
    }
    // A plain Text: the selection scope around the whole message supplies the
    // handles, and a container of this paragraph's own would end a drag here.
    AppSelectable {
        Text(text = annotated, style = base, modifier = modifier)
    }
}

/**
 * Confirms where an agent-authored link goes before the app leaves for it.
 *
 * A markdown label is arbitrary text — `[https://github.com/acme/repo](https://evil.example/)`
 * is indistinguishable from the real thing on a phone, where there is no hover
 * and the URL is never drawn — so the destination host is named in a dialog the
 * reader has to accept. The open itself is wrapped: `openUri` starts an activity
 * and can still throw for a scheme nothing on the device handles.
 */
@Composable
private fun rememberMarkdownLinkListener(): LinkInteractionListener {
    val uriHandler = LocalUriHandler.current
    val ambient = LocalAppDialogHost.current
    val own = rememberAppDialogHostState()
    val dialogs = ambient ?: own
    val scope = rememberCoroutineScope()
    // The screen's own host is used when it published one; otherwise this text
    // hosts the question itself rather than opening without asking.
    if (ambient == null) AppDialogHost(own)
    return remember(dialogs, uriHandler, scope) {
        object : LinkInteractionListener {
            override fun onClick(link: LinkAnnotation) {
                val url = (link as? LinkAnnotation.Url)?.url ?: return
                val host = SafeExternalUrl.displayHost(url) ?: return
                scope.launch {
                    val open = dialogs.confirm(
                        title = "Open $host?",
                        message = "This link came from the conversation. It opens " +
                            "${SafeExternalUrl.forDisplay(url)} outside pi pod.",
                        confirmLabel = "Open",
                        confirmSemanticsLabel = "Open $host",
                        cancelSemanticsLabel = "Do not leave pi pod",
                    )
                    // ACTION_VIEW can still fail — a scheme nothing handles, a
                    // disabled browser — and a link in a transcript must never
                    // be able to take the process down.
                    if (open) runCatching { uriHandler.openUri(url) }
                }
            }
        }
    }
}

/**
 * The styled runs as one annotated string, built once per distinct text.
 *
 * A link only becomes a [LinkAnnotation.Url] when [SafeExternalUrl] accepts it.
 * Anything else keeps its original markdown, verbatim and unstyled: dropping the
 * URL would hide what the agent actually wrote, and styling it as a link would
 * promise a tap that must not happen.
 */
internal fun markdownAnnotatedString(
    tokens: List<MarkdownInlineToken>,
    base: TextStyle,
    colors: AppColors,
    onLinkTapped: LinkInteractionListener? = null,
): AnnotatedString = buildAnnotatedString {
    for (token in tokens) {
        var tokenStyle = base
        if (token.bold) tokenStyle = tokenStyle.copy(fontWeight = FontWeight.Bold)
        if (token.italic) tokenStyle = tokenStyle.copy(fontStyle = FontStyle.Italic)
        if (token.code) {
            tokenStyle = MonospaceTextStyle.merge(tokenStyle).copy(
                fontFamily = MonospaceTextStyle.fontFamily,
                fontSize = MonospaceTextStyle.fontSize,
                background = colors.fill.copy(alpha = 0.6f),
            )
        }
        val link = token.link
        if (link == null || !SafeExternalUrl.isSafe(link)) {
            val text = if (link == null) token.text else "[${token.text}]($link)"
            withStyle(tokenStyle.toSpanStyle()) { append(text) }
        } else {
            tokenStyle = tokenStyle.copy(
                color = colors.accent,
                textDecoration = TextDecoration.Underline,
            )
            // A real link annotation, not the Flutter original's WidgetSpan and
            // GestureDetector: Compose gives the run the link role, the tap target and
            // the URI handler for free, so the accessible name needs no hand-rolling.
            val span = tokenStyle.toSpanStyle()
            withLink(LinkAnnotation.Url(link, TextLinkStyles(style = span), onLinkTapped)) {
                withStyle(span) { append(token.text) }
            }
        }
    }
}

/** One run of inline text plus the marks that apply to it. */
data class MarkdownInlineToken(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
) {

    companion object {
        fun parse(input: String): List<MarkdownInlineToken> {
            val tokens = mutableListOf<MarkdownInlineToken>()
            val buffer = StringBuilder()
            var index = 0

            fun flush() {
                if (buffer.isEmpty()) return
                tokens.add(MarkdownInlineToken(text = buffer.toString()))
                buffer.setLength(0)
            }

            fun startsWith(marker: String): Boolean = input.startsWith(marker, index)

            /** Code spans win over emphasis, so `**` inside backticks stays literal. */
            fun closingIndex(marker: String): Int = input.indexOf(marker, index + marker.length)

            while (index < input.length) {
                if (startsWith("`")) {
                    val end = closingIndex("`")
                    // An empty span (``) is shown verbatim: an empty code token would
                    // paint a background box around nothing.
                    if (end > index + 1) {
                        flush()
                        tokens.add(
                            MarkdownInlineToken(text = input.substring(index + 1, end), code = true),
                        )
                        index = end + 1
                        continue
                    }
                }
                if (startsWith("**")) {
                    val end = closingIndex("**")
                    // **** is shown verbatim rather than parsed as bold-around-nothing,
                    // which would swallow the text entirely.
                    if (end > index + 2) {
                        flush()
                        for (nested in parse(input.substring(index + 2, end))) {
                            tokens.add(nested.copy(bold = true))
                        }
                        index = end + 2
                        continue
                    }
                }
                if (startsWith("*") || startsWith("_")) {
                    val marker = input[index].toString()
                    val end = closingIndex(marker)
                    // Underscores are not word delimiters in code, so `some_function_name` must
                    // not become emphasis. CommonMark forbids intraword `_` for exactly this
                    // reason; `*` keeps working intraword.
                    val boundaryOk = marker != "_" ||
                        ((index == 0 || !isWordCharacter(input[index - 1])) &&
                            (end + 1 >= input.length || !isWordCharacter(input[end + 1])))
                    if (end > index + 1 && boundaryOk) {
                        flush()
                        for (nested in parse(input.substring(index + 1, end))) {
                            tokens.add(nested.copy(italic = true))
                        }
                        index = end + 1
                        continue
                    }
                }
                if (startsWith("[")) {
                    val close = input.indexOf(']', index)
                    if (close > index && close + 1 < input.length && input[close + 1] == '(') {
                        val urlEnd = input.indexOf(')', close + 2)
                        if (urlEnd > close) {
                            flush()
                            tokens.add(
                                MarkdownInlineToken(
                                    text = input.substring(index + 1, close),
                                    link = input.substring(close + 2, urlEnd),
                                ),
                            )
                            index = urlEnd + 1
                            continue
                        }
                    }
                }
                buffer.append(input[index])
                index += 1
            }
            flush()
            if (tokens.isEmpty() && input.isNotEmpty()) {
                // Totality guarantee: styled or not, no input may render as nothing.
                // (Reached only if every marker above fell through to verbatim text
                // that for some reason never flushed.)
                tokens.add(MarkdownInlineToken(text = input))
            }
            return tokens
        }

        private fun isWordCharacter(character: Char): Boolean {
            val code = character.code
            val isDigit = code in 0x30..0x39
            val isUpper = code in 0x41..0x5A
            val isLower = code in 0x61..0x7A
            return isDigit || isUpper || isLower || character == '_'
        }
    }
}
