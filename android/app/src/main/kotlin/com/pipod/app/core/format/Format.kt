package com.pipod.app.core.format

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.chrono.IsoChronology
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Gregorian calendar with an injectable time zone.
 *
 * Mirrors the subset of Foundation `Calendar` that [Format.transcriptDay] uses,
 * so tests can pin GMT+0 the way the Swift tests pin
 * `TimeZone(secondsFromGMT: 0)`. The offset is fixed rather than a [ZoneId]
 * because a wall-clock day boundary is all this has to answer, and a fixed
 * offset is what the Dart and Swift versions carry.
 */
data class Calendar(val timeZoneOffset: ZoneOffset = ZoneOffset.UTC) {

    fun isSameDay(a: Instant, b: Instant): Boolean = inZone(a).toLocalDate() == inZone(b).toLocalDate()

    fun addDays(date: Instant, days: Int): Instant = inZone(date).plusDays(days.toLong()).toInstant(timeZoneOffset)

    fun yearOf(date: Instant): Int = inZone(date).year

    /**
     * Civil date-time in this calendar's zone. Components (not the instant) are
     * what the formatters and same-day checks consume.
     */
    fun inZone(date: Instant): LocalDateTime = LocalDateTime.ofInstant(date, timeZoneOffset)

    companion object {
        /** System offset at the moment of the call, including the current DST bias. */
        fun current(): Calendar = Calendar(ZoneId.systemDefault().rules.getOffset(Instant.now()))
    }
}

/** Display helpers for ISO timestamps and transcript cluster headers. */
object Format {

    /**
     * Accepts what the server sends (an internet date-time, with or without
     * fractional seconds) and, like Dart's `DateTime.tryParse`, a stamp that
     * omits its offset or its time — those resolve against the device zone.
     */
    fun date(isoString: String): Instant? {
        val text = isoString.trim()
        if (text.isEmpty()) return null
        val parsed = runCatching {
            DateTimeFormatter.ISO_DATE_TIME.parseBest(text, OffsetDateTime::from, LocalDateTime::from)
        }.getOrNull()
        return when (parsed) {
            is OffsetDateTime -> parsed.toInstant()
            is LocalDateTime -> parsed.atZone(ZoneId.systemDefault()).toInstant()
            else -> runCatching {
                LocalDate.parse(text).atStartOfDay(ZoneId.systemDefault()).toInstant()
            }.getOrNull()
        }
    }

    /** "3m ago" / "2d ago" for an ISO timestamp; null when it does not parse. */
    fun relative(isoString: String?, now: Instant = Instant.now()): String? {
        val parsed = isoString?.let { date(it) } ?: return null
        // "in 0s" for timestamps a clock skew puts slightly in the future reads
        // as a bug.
        if (parsed.isAfter(now)) return "just now"
        val bare = duration(since = isoString, now = now) ?: return null
        return "$bare ago"
    }

    fun absolute(
        isoString: String,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String? {
        val parsed = date(isoString) ?: return null
        return parsed.atZone(zone).format(formatter(dateTimePattern(locale), locale))
    }

    /**
     * Bare elapsed duration — "3m", "2h", "5d" — for "waiting 3m" phrasing where
     * "waiting since 3m ago" would read twice.
     */
    fun duration(since: String?, now: Instant = Instant.now()): String? {
        val parsed = since?.let { date(it) } ?: return null
        val seconds = elapsedSeconds(from = parsed, to = now)
        if (seconds < 60) return "${seconds}s"
        if (seconds < 3600) return "${seconds / 60}m"
        if (seconds < 86400) return "${seconds / 3600}h"
        return "${seconds / 86400}d"
    }

    /** Timestamp for a transcript row: time only for today, day + time once older. */
    fun transcriptTime(
        date: Instant,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        val local = date.atZone(zone)
        val isToday = local.toLocalDate() == now.atZone(zone).toLocalDate()
        val pattern = if (isToday) timePattern(locale) else dateTimePattern(locale)
        return local.format(formatter(pattern, locale))
    }

    /**
     * Day header for a transcript cluster. Locale is injectable so tests can pin
     * "Aug 13" without depending on the host region.
     */
    fun transcriptDay(
        date: Instant,
        now: Instant = Instant.now(),
        calendar: Calendar = Calendar.current(),
        locale: Locale = Locale.getDefault(),
    ): String {
        if (calendar.isSameDay(date, now)) return "Today"
        if (calendar.isSameDay(date, calendar.addDays(now, -1))) return "Yesterday"
        val zoned = calendar.inZone(date)
        val pattern =
            if (calendar.yearOf(date) != calendar.yearOf(now)) datePattern(locale) else monthDayPattern(locale)
        return zoned.format(formatter(pattern, locale))
    }

    private fun elapsedSeconds(from: Instant, to: Instant): Long {
        val seconds = Duration.between(from, to).seconds
        return if (seconds < 0) 0 else seconds
    }

    /**
     * `intl`'s skeletons have no `java.time` equivalent, so the locale's own
     * medium/short patterns stand in: for `en_US` they are the same
     * "MMM d, y" and "h:mm a" that `DateFormat.yMMMd().add_jm()` produces.
     */
    private fun datePattern(locale: Locale): String = localizedPattern(FormatStyle.MEDIUM, null, locale)

    private fun timePattern(locale: Locale): String = localizedPattern(null, FormatStyle.SHORT, locale)

    private fun dateTimePattern(locale: Locale): String = "${datePattern(locale)} ${timePattern(locale)}"

    /** The medium date with its year field taken out, leaving `MMMd`'s "Jun 1". */
    private fun monthDayPattern(locale: Locale): String {
        val stripped = StringBuilder()
        var quoted = false
        for (character in datePattern(locale)) {
            if (character == '\'') quoted = !quoted
            if (!quoted && (character == 'y' || character == 'u' || character == 'Y')) continue
            stripped.append(character)
        }
        // Whatever punctuation joined the year to the rest goes with it.
        return stripped.toString()
            .trim { it.isWhitespace() || it in ",./-" }
            .replace(REPEATED_SPACES, " ")
    }

    private fun localizedPattern(date: FormatStyle?, time: FormatStyle?, locale: Locale): String =
        DateTimeFormatterBuilder.getLocalizedDateTimePattern(date, time, IsoChronology.INSTANCE, locale)

    private fun formatter(pattern: String, locale: Locale): DateTimeFormatter =
        FORMATTERS.getOrPut("$locale\u0000$pattern") { DateTimeFormatter.ofPattern(pattern, locale) }

    private val FORMATTERS = ConcurrentHashMap<String, DateTimeFormatter>()
    private val REPEATED_SPACES = Regex("\\s{2,}")
}
