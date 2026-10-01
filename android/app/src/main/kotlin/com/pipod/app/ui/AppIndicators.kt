package com.pipod.app.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors

/**
 * Work is in progress and there is no way to say how far along it is.
 *
 * Ported from `pi-pod-flutter/lib/ui/app_indicators.dart`.
 *
 * @param size the glyph's edge length. Null takes the platform default, which
 *   is what a full-screen loading state wants; a spinner sitting inside a
 *   button or a row names its own size and gets a proportionally thinner
 *   stroke, because a 4dp stroke on a 16dp circle is a solid disc.
 */
@Composable
fun AppActivityIndicator(modifier: Modifier = Modifier, size: Dp? = null) {
    if (size == null) {
        CircularProgressIndicator(modifier = modifier)
    } else {
        CircularProgressIndicator(
            modifier = modifier.size(size),
            strokeWidth = if (size < 24.dp) 2.dp else 4.dp,
        )
    }
}

/**
 * Work with a known extent.
 *
 * @param progress null while the total is still unknown, which renders the
 *   indeterminate bar rather than an empty one — an empty determinate bar reads
 *   as "nothing has happened".
 */
@Composable
fun AppProgressBar(progress: Float?, modifier: Modifier = Modifier) {
    if (progress == null) {
        LinearProgressIndicator(modifier = modifier)
    } else {
        LinearProgressIndicator(progress = { progress }, modifier = modifier)
    }
}

/**
 * A count of things waiting, attached to the glyph they are waiting on.
 *
 * With no [content] the badge stands alone, which is how a count inside a row
 * is drawn; with one it rides the corner of that glyph.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppBadge(
    count: Int,
    modifier: Modifier = Modifier,
    content: (@Composable () -> Unit)? = null,
) {
    if (content == null) {
        Badge(modifier = modifier) { Text("$count") }
    } else {
        BadgedBox(
            modifier = modifier,
            badge = { Badge { Text("$count") } },
            content = { content() },
        )
    }
}

/** A hairline, for the rare separator that is not drawn by a list section. */
@Composable
fun AppSeparator(modifier: Modifier = Modifier) {
    HorizontalDivider(
        modifier = modifier,
        thickness = 1.dp,
        color = appColors.separator,
    )
}
