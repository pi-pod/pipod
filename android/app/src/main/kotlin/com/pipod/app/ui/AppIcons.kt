package com.pipod.app.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayCircleFilled
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FindInPage
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.QuestionAnswer
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowCircleUp
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.CalendarMonth
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.CheckCircleOutline
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Circle
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Error
import androidx.compose.material.icons.rounded.ExploreOff
import androidx.compose.material.icons.rounded.FilterList
import androidx.compose.material.icons.rounded.FilterListOff
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Memory
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Restore
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.SearchOff
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.StopCircle
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.SyncProblem
import androidx.compose.material.icons.rounded.Terminal
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Every glyph the app draws, named for what it means rather than what it looks
 * like, mirroring `pi-pod-flutter/lib/ui/app_icons.dart`.
 *
 * Naming by meaning is what lets a screen say `offline` without knowing which
 * glyph currently says it. The Flutter original picks between SF Symbols and
 * Material per platform; Android only ever needs the Material half, so the
 * choice collapses to a constant here.
 *
 * Each entry is a `get()` rather than a `val`: the icon library builds and
 * caches a vector on first read, and eagerly building 60 of them at class-init
 * would cost the first frame for glyphs most screens never draw.
 */
object AppIcons {

    // Navigation destinations. The selected variant is the filled or rounded
    // twin, which is how a Material tab bar marks the current destination.
    val pods: ImageVector get() = Icons.Outlined.Dns
    val podsSelected: ImageVector get() = Icons.Rounded.Dns
    val jobs: ImageVector get() = Icons.Outlined.CalendarMonth
    val jobsSelected: ImageVector get() = Icons.Rounded.CalendarMonth
    val settings: ImageVector get() = Icons.Outlined.Settings
    val settingsSelected: ImageVector get() = Icons.Rounded.Settings
    val brand: ImageVector get() = Icons.Rounded.Terminal

    // Structural affordances.
    val add: ImageVector get() = Icons.Rounded.Add
    val chevron: ImageVector get() = Icons.Rounded.ChevronRight
    val expand: ImageVector get() = Icons.Filled.KeyboardArrowDown
    val more: ImageVector get() = Icons.Rounded.MoreHoriz
    val close: ImageVector get() = Icons.Filled.Cancel
    val search: ImageVector get() = Icons.Rounded.Search
    val noResults: ImageVector get() = Icons.Rounded.SearchOff
    val filter: ImageVector get() = Icons.Rounded.FilterList
    val filterActive: ImageVector get() = Icons.Rounded.FilterListOff

    /** Auto-mirrored: these read as "away from here", which flips under RTL. */
    val openExternal: ImageVector get() = Icons.AutoMirrored.Rounded.OpenInNew
    val forward: ImageVector get() = Icons.AutoMirrored.Rounded.ArrowForward

    val send: ImageVector get() = Icons.Rounded.ArrowCircleUp
    val submit: ImageVector get() = Icons.Rounded.ArrowUpward
    val refresh: ImageVector get() = Icons.Rounded.Refresh
    val history: ImageVector get() = Icons.Rounded.History
    val schedule: ImageVector get() = Icons.Rounded.Schedule
    val edit: ImageVector get() = Icons.Rounded.Edit
    val delete: ImageVector get() = Icons.Rounded.DeleteOutline
    val archive: ImageVector get() = Icons.Outlined.Archive
    val restore: ImageVector get() = Icons.Rounded.Restore
    val interrupt: ImageVector get() = Icons.Filled.StopCircle
    val stop: ImageVector get() = Icons.Rounded.StopCircle
    val show: ImageVector get() = Icons.Filled.Visibility
    val hide: ImageVector get() = Icons.Outlined.VisibilityOff

    // Status and outcome.
    val success: ImageVector get() = Icons.Rounded.CheckCircle
    val successOutline: ImageVector get() = Icons.Rounded.CheckCircleOutline
    val check: ImageVector get() = Icons.Rounded.Check
    val warning: ImageVector get() = Icons.Rounded.Warning
    val warningOutline: ImageVector get() = Icons.Outlined.WarningAmber
    val error: ImageVector get() = Icons.Rounded.Error
    val errorOutline: ImageVector get() = Icons.Outlined.ErrorOutline
    val info: ImageVector get() = Icons.Outlined.Info
    val unknown: ImageVector get() = Icons.AutoMirrored.Rounded.HelpOutline
    val copy: ImageVector get() = Icons.Rounded.ContentCopy
    val offline: ImageVector get() = Icons.Rounded.WifiOff
    val syncing: ImageVector get() = Icons.Rounded.Sync
    val syncProblem: ImageVector get() = Icons.Rounded.SyncProblem
    val lost: ImageVector get() = Icons.Rounded.ExploreOff
    val dot: ImageVector get() = Icons.Rounded.Circle
    val dotOutline: ImageVector get() = Icons.Outlined.Circle

    // Domain objects.
    val running: ImageVector get() = Icons.Filled.PlayCircleFilled
    val asleep: ImageVector get() = Icons.Rounded.Bedtime
    val asleepOutline: ImageVector get() = Icons.Outlined.Bedtime
    val archived: ImageVector get() = Icons.Outlined.Inventory2
    val unavailable: ImageVector get() = Icons.Rounded.CloudOff
    val resources: ImageVector get() = Icons.Rounded.Memory
    val environment: ImageVector get() = Icons.Outlined.Layers
    val secret: ImageVector get() = Icons.Rounded.Key
    val person: ImageVector get() = Icons.Rounded.Person
    val conversation: ImageVector get() = Icons.Outlined.Forum
    val question: ImageVector get() = Icons.Outlined.QuestionAnswer
    val inspect: ImageVector get() = Icons.Outlined.FindInPage
    val attach: ImageVector get() = Icons.Outlined.Image
    val suggestion: ImageVector get() = Icons.Rounded.AutoAwesome
}
