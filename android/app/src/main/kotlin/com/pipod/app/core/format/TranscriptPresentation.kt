package com.pipod.app.core.format

import com.pipod.app.core.session.StreamItem
import com.pipod.app.core.session.StreamItemStyle
import java.time.Duration
import java.time.Instant

/**
 * Turns the flat event stream into the rows a chat transcript actually shows:
 * day headers, grouped consecutive turns, and which chrome each bubble needs.
 *
 * Grouping is a display concern, not a protocol one — the stream stays a list of
 * events so reconnect/replay can keep matching by id. The row type
 * ([com.pipod.app.core.session.StreamItem]) lives beside the reducer that
 * produces it.
 */
object TranscriptPresentation {

    /**
     * Consecutive same-sender turns closer than this share one label and one
     * timestamp.
     */
    val GROUPING_INTERVAL: Duration = Duration.ofMinutes(5)

    fun rows(
        items: List<StreamItem>,
        now: Instant = Instant.now(),
        calendar: Calendar = Calendar.current(),
    ): List<TranscriptRow> {
        val rows = mutableListOf<TranscriptRow>()
        var lastDayId: String? = null
        var days = 0
        var index = 0
        while (index < items.size) {
            val item = items[index]
            val timestamp = item.timestamp
            if (timestamp != null) {
                val dayId = dayIdentifier(timestamp, calendar)
                if (dayId != lastDayId) {
                    rows.add(
                        TranscriptRow.Day(
                            dayId = dayId,
                            ordinal = days,
                            title = Format.transcriptDay(timestamp, now = now, calendar = calendar),
                        ),
                    )
                    days += 1
                    lastDayId = dayId
                }
            }
            if (item.style == StreamItemStyle.TOOL) {
                val run = mutableListOf<StreamItem>()
                while (index < items.size && items[index].style == StreamItemStyle.TOOL) {
                    run.add(items[index])
                    index += 1
                }
                rows.add(TranscriptRow.Tools(run))
                continue
            }
            val previous = if (index > 0) items[index - 1] else null
            val next = if (index + 1 < items.size) items[index + 1] else null
            rows.add(
                TranscriptRow.Item(
                    item,
                    chrome(item, previous = previous, next = next, calendar = calendar),
                ),
            )
            index += 1
        }
        return rows
    }

    fun chrome(
        item: StreamItem,
        previous: StreamItem? = null,
        next: StreamItem? = null,
        calendar: Calendar = Calendar.current(),
    ): MessageChrome {
        if (item.style != StreamItemStyle.USER && item.style != StreamItemStyle.ASSISTANT) {
            return MessageChrome.CHROME_LESS
        }
        val isContinuation = previous != null && groups(previous, item, calendar)
        val continuesAfter = next != null && groups(item, next, calendar)
        return MessageChrome(
            showsSender = !isContinuation,
            showsTimestamp = !continuesAfter,
            isContinuation = isContinuation,
        )
    }

    /**
     * True when the last row is already a live assistant/tool bubble — a second
     * "pi is working" indicator under it would just repeat the same fact.
     */
    fun showsTypingIndicator(isRunning: Boolean, lastItem: StreamItem?): Boolean {
        if (!isRunning) return false
        if (lastItem != null &&
            lastItem.isInProgress &&
            (lastItem.style == StreamItemStyle.ASSISTANT || lastItem.style == StreamItemStyle.TOOL)
        ) {
            return false
        }
        return true
    }

    private fun groups(lhs: StreamItem, rhs: StreamItem, calendar: Calendar): Boolean {
        if (lhs.style != rhs.style) return false
        if (lhs.style != StreamItemStyle.USER && lhs.style != StreamItemStyle.ASSISTANT) return false
        val left = lhs.timestamp
        val right = rhs.timestamp
        if (left != null && right != null) {
            return Duration.between(left, right).abs() < GROUPING_INTERVAL &&
                calendar.isSameDay(left, right)
        }
        if (left == null && right == null) return true
        return false
    }

    private fun dayIdentifier(date: Instant, calendar: Calendar): String {
        val components = calendar.inZone(date)
        return "${components.year}-${components.monthValue}-${components.dayOfMonth}"
    }
}

sealed interface TranscriptRow {
    val id: String

    /**
     * [ordinal] counts emissions, not days.
     *
     * A header is emitted whenever the day differs from the row immediately
     * above, and the transcript mixes server timestamps with the device clock's
     * (an optimistic send is stamped locally). A device a day behind the server
     * therefore produces [D5][D4][D5] — the same `dayId` twice, and a
     * `LazyColumn` answers a duplicate key by throwing. The position is what
     * makes each header unique; the day itself may repeat.
     */
    data class Day(val dayId: String, val ordinal: Int, val title: String) : TranscriptRow {
        override val id: String get() = "day-$dayId-$ordinal"
    }

    data class Item(val item: StreamItem, val chrome: MessageChrome) : TranscriptRow {
        override val id: String get() = item.id
    }

    data class Tools(val items: List<StreamItem>) : TranscriptRow {
        override val id: String get() = "tools-${items.firstOrNull()?.id ?: ""}"
    }
}

data class MessageChrome(
    val showsSender: Boolean,
    val showsTimestamp: Boolean,
    val isContinuation: Boolean,
) {
    companion object {
        val STANDALONE = MessageChrome(
            showsSender = true,
            showsTimestamp = true,
            isContinuation = false,
        )

        val CHROME_LESS = MessageChrome(
            showsSender = false,
            showsTimestamp = false,
            isContinuation = false,
        )
    }
}
