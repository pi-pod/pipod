package com.pipod.app.core.format

import com.pipod.app.core.api.model.JobTrigger
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * Human labels for job schedules. Cron fires in UTC on the server, so cron text
 * keeps its UTC qualifier; "at" times are instants and format in the user's
 * local time zone.
 */
object JobSchedule {

    fun summary(trigger: JobTrigger, now: Instant = Instant.now()): String = when (trigger) {
        is JobTrigger.Cron -> humanizeCron(trigger.expression) ?: "cron “${trigger.expression}” (UTC)"
        is JobTrigger.At -> atSummary(times = trigger.times, now = now)
    }

    /**
     * The schedule in words, with the local clock time in brackets.
     *
     * The local time is computed from the actual UTC instant of the next
     * occurrence, not from the offset sampled "now": sampling now reads the
     * wrong offset either side of a DST change, and — worse — shifting only the
     * time of day leaves the day of the week saying the UTC one. "Every Monday
     * at 23:30 UTC" at UTC+2 fires at 01:30 on **Tuesday**; the bracket used to
     * read "01:30 local" beside the word Monday, which is a schedule nobody
     * has. When the day shifts, the annotation names the local day too rather
     * than quietly contradicting the sentence.
     *
     * @param nextRunAt the next occurrence as the server computed it. Without
     *   one there is no instant to resolve against and the bracket is omitted:
     *   a guessed offset is what this is fixing.
     */
    fun detailSummary(
        trigger: JobTrigger,
        nextRunAt: String? = null,
        zone: ZoneId = ZoneId.systemDefault(),
    ): String {
        val summary = summary(trigger)
        if (trigger !is JobTrigger.Cron) return summary
        if (humanizeCron(trigger.expression) == null) return summary
        val instant = nextRunAt?.let { Format.date(it) } ?: return summary
        val local = instant.atZone(zone)
        val utc = instant.atZone(ZoneOffset.UTC)
        val clock = "%02d:%02d".format(local.hour, local.minute)
        if (local.dayOfWeek == utc.dayOfWeek) return "$summary ($clock local)"
        // The local day is not the UTC day the sentence names, so it is said.
        val day = DAY_NAMES[local.dayOfWeek.value % 7]
        return "$summary ($day $clock local)"
    }

    fun atSummary(times: List<String>, now: Instant): String {
        if (times.size == 1) {
            val label = Format.absolute(times[0]) ?: times[0]
            return "Once, $label"
        }
        val remaining = remainingCount(times = times, now = now)
        return "${times.size} times, ${if (remaining == 0) "all done" else "$remaining remaining"}"
    }

    /**
     * Times strictly in the future; unparseable entries count as past so they
     * never inflate what the schedule still owes.
     */
    fun remainingCount(times: List<String>, now: Instant): Int =
        times.count { (Format.date(it) ?: Instant.EPOCH).isAfter(now) }

    /**
     * "in 3m" / "in 2h" for an upcoming instant. [Format.relative] clamps future
     * timestamps to "just now", which is exactly wrong for a next run.
     */
    fun countdown(to: String?, now: Instant = Instant.now()): String? {
        val date = to?.let { Format.date(it) } ?: return null
        val seconds = Duration.between(now, date).seconds
        if (seconds <= 0) return "now"
        if (seconds < 60) return "in ${seconds}s"
        if (seconds < 3600) return "in ${seconds / 60}m"
        if (seconds < 86400) return "in ${seconds / 3600}h"
        return "in ${seconds / 86400}d"
    }

    /**
     * Plain-shape crons ("30 9 * * 1") become words; anything richer returns null
     * and the raw expression stands, because a wrong paraphrase is worse than
     * cron syntax.
     */
    fun humanizeCron(cron: String): String? {
        val fields = cron.split(WHITESPACE).filter { it.isNotEmpty() }
        if (fields.size != 5) return null
        val minute = fields[0].toIntOrNull()
        val hour = fields[1].toIntOrNull()
        if (minute == null || minute < 0 || minute > 59) return null
        if (hour == null || hour < 0 || hour > 23) return null
        if (fields[3] != "*") return null
        val time = "${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} UTC"
        val dayOfMonth = fields[2]
        val dayOfWeek = fields[4]
        if (dayOfMonth == "*" && dayOfWeek == "*") return "Every day at $time"
        if (dayOfMonth == "*") {
            dayNames(dayOfWeek)?.let { return "Every $it at $time" }
        }
        if (dayOfWeek == "*") {
            val day = dayOfMonth.toIntOrNull()
            if (day != null && day in 1..31) return "Monthly on the ${ordinal(day)} at $time"
        }
        return null
    }

    private fun dayNames(field: String): String? {
        if (field == "1-5") return "weekday"
        val days = mutableListOf<String>()
        for (part in field.split(",")) {
            val n = part.toIntOrNull()
            if (n == null || n < 0 || n > 7) return null
            days.add(DAY_NAMES[n % 7])
        }
        if (days.isEmpty()) return null
        if (days.size == 1) return days.single()
        return "${days.subList(0, days.size - 1).joinToString(", ")} and ${days.last()}"
    }

    private fun ordinal(n: Int): String {
        val suffix = when (n % 100) {
            11, 12, 13 -> "th"
            else -> when (n % 10) {
                1 -> "st"
                2 -> "nd"
                3 -> "rd"
                else -> "th"
            }
        }
        return "$n$suffix"
    }

    private val WHITESPACE = Regex("\\s+")
    private val DAY_NAMES = listOf(
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    )
}
