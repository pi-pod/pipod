# Design system

The shared widget vocabulary every screen is written against, ported from
`pi-pod-flutter/lib/ui/` and `pi-pod-flutter/lib/features/common/`.

Two packages:

- `com.pipod.app.ui` — the vocabulary itself (buttons, lists, fields, chrome).
- `com.pipod.app.features.common` — the composed pieces every feature reuses
  (empty states, status chips, secret forms).

Three rules that hold everywhere:

1. **Name a role, not a colour.** Read `PiPod.colors` / `appColors` and ask for
   `secondaryLabel`, `separator`, `card`, `destructive`. Do not reach into
   `MaterialTheme.colorScheme` from a screen. `notice` is the glyph and fill
   tint; **text** in that role uses `noticeText`, which is hand-pinned in both
   themes to clear 4.5:1 on `card`, `background`, `noticeFill` and the 12%
   dialog-card wash (`AppColorsContrastRound2Test` measures all eight pairings —
   Material's raw tertiary reads 3.3:1 to 4.3:1 on them).
2. **One node per control.** Pass `semanticsLabel` to the widget instead of
   wrapping it in `Modifier.semantics { … }`. A wrapper exposes the control
   twice, and the manual UI tests drive the app by these labels.
3. **State is hoisted.** Fields take `value` + `onValueChange`, not a
   controller; buttons take `enabled`, not a nullable callback.

---

## Chrome

| Composable | Signature | Use when |
| --- | --- | --- |
| `AppScaffold` | `(modifier, title: String?, titleContent: (@Composable () -> Unit)?, titleSemanticsLabel: String?, onNavigateBack: (() -> Unit)?, navigationIcon, actions: @Composable RowScope.() -> Unit, grouped: Boolean, floatingActionButton, bottomBar, toastHostState, content: @Composable (PaddingValues) -> Unit)` | Any screen with a top bar. The bar disappears entirely when nothing is put in it. A `title` is one line, ellipsised — long pod and environment names, and almost every title at font scale 2.0, would otherwise be clipped mid-glyph. |
| `AppListScaffold` | `(title, modifier, titleSemanticsLabel, onNavigateBack, navigationIcon, actions, grouped = true, isRefreshing, onRefresh: (() -> Unit)?, refreshSemanticsLabel, listState, contentPadding = AppListPadding, floatingActionButton, toastHostState, content: LazyListScope.() -> Unit)` | A scrolling list screen. Adds pull-to-refresh plus a named custom accessibility action for it. |
| `AppBackButton` | `(onClick, modifier)` | The way out of a pushed screen. Always named exactly `"Back"`. |
| `AppCloseButton` | `(onClick, semanticsLabel = "Close", modifier)` | A screen presented as a task, which is dismissed rather than left. |
| `appScaffoldBackground` | `(grouped: Boolean = false): Color` | A screen painting its own body instead of handing content to `AppScaffold`. |
| `AppRouteTransitions` | `enter` / `exit` / `popEnter` / `popExit` / `modalEnter` / `modalExit` | `NavHost` `composable(...)` transitions. `modal*` is for a screen presented as a task. |

## Buttons

| Composable | Signature | Use when |
| --- | --- | --- |
| `AppButton` | `(text: String, onClick, modifier, kind = Filled, enabled = true, destructive = false, size = Normal, contentPadding, minSize, semanticsLabel)` | Any button whose child is a plain label. |
| `AppButton` | `(onClick, modifier, kind, enabled, destructive, size, contentPadding, minSize, semanticsLabel, content: @Composable RowScope.() -> Unit)` | A button whose child is more than text — pair it with `AppButtonContent`. |
| `AppButtonContent` | `(icon: ImageVector, label: String, iconSize = 20.dp)` | The icon+label child of the slot `AppButton`. |
| `AppIconButton` | `(icon, onClick, semanticsLabel, modifier, enabled, destructive, iconSize, tint, dimension)` | A tappable glyph. `semanticsLabel` is required: it is the button's only name. |
| `AppTonalButton` | `(text, onClick, modifier, enabled)` | A filled secondary action that is not the screen's primary one. |
| `AppFloatingAction` | `(icon, label, onClick, modifier)` | The primary action on a screen too tall to reach into the top bar. |
| `AppPillButton` | `(onClick, semanticsLabel, modifier, content)` | A control floating over scrolling content, such as "jump to latest". |

`AppButtonKind` is `Filled` / `Tinted` / `Plain`; `AppButtonSize` is `Normal` /
`Small`. Every kind and size holds `AppButtonDefaults.MinHeight` (44dp) —
callers may raise it with `minSize`, never lower it.

## Lists

| Composable | Signature | Use when |
| --- | --- | --- |
| `AppListSection` | `(modifier, header: String?, footer: String?, style = Grouped, content: AppListSectionScope.() -> Unit)` | Any group of rows. Renders nothing at all — header included — when no rows are declared. |
| `AppListSectionScope.row` | `(content: @Composable () -> Unit)` | Declares one row. Rows are declared rather than emitted so the section can put separators *between* them. |
| `AppListSectionScope.items` | `(items: List<T>, content: @Composable (T) -> Unit)` | A section built from data. |
| `AppListTile` | `(title, modifier, subtitle, leading, trailing, additionalInfo, onClick, showChevron, backgroundColor, selected, enabled, semanticsLabel, semanticsExpanded)` | One row. |
| `AppSeparator` | `(modifier)` | The rare hairline a list section is not already drawing. |
| `AppListPadding` | `PaddingValues` | The inset a screen puts around a stack of sections. |

`AppSectionStyle.Grouped` is one card with hairlines between rows;
`Separated` gives each row its own card. `semanticsExpanded` is announced as
the row's state description, so a disclosure row's label can stay stable.

## Fields

| Composable | Signature | Use when |
| --- | --- | --- |
| `AppTextField` | `(value, onValueChange, modifier, label, placeholder, enabled, readOnly, obscureText, keyboardOptions, keyboardActions, textStyle, minLines, maxLines, prefixIcon, shape = Box, suffix, isError, semanticsLabel)` | Any text input. |
| `AppSearchField` | `(value, onValueChange, label, placeholder, modifier, enabled)` | A field that filters a list. Keep `label` and `placeholder` identical. |
| `AppOptionPicker` | `(label, value: T, options: List<AppOption<T>>, onValueChange, modifier, enabled)` | One value from a known set. |
| `AppSwitch` | `(checked, onCheckedChange, modifier, enabled)` | A bare switch inside a row a caller is building. |
| `AppSwitchRow` | `(checked, onCheckedChange, modifier, enabled, subtitle, title)` | A labelled setting. The whole row toggles, as one node. |
| `AppSelectableText` | `(text, modifier, style, textAlign, maxLines, semanticsLabel)` | Text the reader can select and copy: a transcript line, an id. |

`AppFieldShape.Box` is an outlined form field; `Pill` is the composer shape
that sits in a bar. On `Box`, `semanticsLabel` *replaces* the visible label
(this is what the Flutter app does on Android); on `Pill` it rides on the
field's own node so the name survives after typing hides the hint.

## Dialogs, sheets and toasts

| Composable / API | Signature | Use when |
| --- | --- | --- |
| `AppDialogHostState.confirm` | `suspend (title, confirmLabel, message = "", cancelLabel = "Cancel", destructive = false, confirmSemanticsLabel, cancelSemanticsLabel): Boolean` | A decision that cannot be undone by looking away. Dismissal answers `false`. |
| `AppDialogHostState.notice` | `suspend (title, message, dismissLabel = "OK", dismissSemanticsLabel)` | Something the reader cannot act on. |
| `rememberAppDialogHostState` / `AppDialogHost` | `(): AppDialogHostState` / `(state)` | Place `AppDialogHost(state)` once per screen; the suspend calls above stay pending until it is composed. |
| `LocalAppDialogHost` | `CompositionLocal<AppDialogHostState?>` | Content too deep to be handed a host — a markdown link inside a transcript row. `AppScaffold` provides one and renders it, the same way it does the toast host, so every screen has one; it is null outside a scaffold, and a composable that finds none raises its own rather than skipping the question. |
| `AppConfirmDialog` | `(title, confirmLabel, onConfirm, onDismiss, modifier, message, cancelLabel, destructive, confirmSemanticsLabel, cancelSemanticsLabel)` | The declarative form, when the decision is already state. |
| `AppNoticeDialog` | `(title, message, onDismiss, modifier, dismissLabel, dismissSemanticsLabel)` | The declarative form of a notice. |
| `AppSheet` | `(onDismissRequest, modifier, maxWidth = 520.dp, preferDialog = false, content: @Composable ColumnScope.() -> Unit)` | A panel of choices the reader works through and then applies. |
| `AppActionSheet` | `(actions: List<AppSheetAction<T>>, onSelected: (T?) -> Unit, modifier)` | A short menu hung off a control. `onSelected(null)` means dismissed. |
| `AppToastHost` / `rememberAppToastHostState` / `showAppToast` | `(hostState, modifier)` / `(): SnackbarHostState` / `suspend (host, message)` | Confirming something small that already happened, such as a copy. `AppScaffold` already hosts one and provides `LocalAppToastHost`. |

`cancelSemanticsLabel` must not contain `confirmSemanticsLabel` — "Cancel
Delete pod permanently" reads as one merged instruction. Scope it instead:
"Cancel deleting Test pod". This is asserted.

## Indicators

| Composable | Signature | Use when |
| --- | --- | --- |
| `AppActivityIndicator` | `(modifier, size: Dp? = null)` | Work with no known extent. Pass a size inside a button or row; leave it null full-screen. |
| `AppProgressBar` | `(progress: Float?, modifier)` | Work with a known extent. `null` renders the indeterminate bar. |
| `AppBadge` | `(count: Int, modifier, content: (@Composable () -> Unit)? = null)` | A count of things waiting, alone or on the corner of a glyph. |

## Terminal output

| API | Signature | Use when |
| --- | --- | --- |
| `AnsiText` | `(line, style, modifier, palette = AnsiPalette.current())` | One rendered line. Never wraps: the pod already laid it out. |
| `AnsiLines` | `(lines, style, metrics, modifier, semanticsLabel)` | A block of lines on a stable grid, read as one accessibility node. |
| `AnsiPalette.current()` | `(): AnsiPalette` | The terminal palette resolved against the current theme. |
| `rememberAnsiCellMetrics` | `(style: TextStyle): AnsiCellMetrics` | The cell size the style paints at, including the system text-scale setting. |
| `AnsiCellMetrics.columnsIn` / `.rowsIn` | `(available: Dp): Int` | The grid to tell the pod about. Always rounds **down**, clamped to `1..MAX_CELLS`. |

Use `MonospaceTextStyle` from `ui.theme` as the `style`.

## Icons

`AppIcons` names every glyph by meaning: `pods`, `podsSelected`, `jobs`,
`settings`, `brand`, `add`, `chevron`, `expand`, `more`, `close`, `search`,
`noResults`, `filter`, `filterActive`, `openExternal`, `send`, `submit`,
`forward`, `refresh`, `history`, `schedule`, `edit`, `delete`, `archive`,
`restore`, `interrupt`, `stop`, `show`, `hide`, `success`, `successOutline`,
`check`, `warning`, `warningOutline`, `error`, `errorOutline`, `info`,
`unknown`, `copy`, `offline`, `syncing`, `syncProblem`, `lost`, `dot`,
`dotOutline`, `running`, `asleep`, `asleepOutline`, `archived`, `unavailable`,
`resources`, `environment`, `secret`, `person`, `conversation`, `question`,
`inspect`, `attach`, `suggestion`.

Ask for the meaning. Do not reach into `Icons.*` from a screen.

## Layout

| API | Signature | Use when |
| --- | --- | --- |
| `isCompactWidth` | `(): Boolean` | Branching on the phone layout. |
| `currentWindowWidth` | `(): Dp` | The width to branch on, overridable through `LocalWindowWidth`. |
| `windowWidthSizeClass` | `(): WindowWidthSizeClass` | A layout that wants Material's three buckets rather than two. |
| `CompactWidthBreakpoint` | `700.dp` | pi pod's own cut, not Material's 600dp. |

## Feature-common widgets

| Composable | Signature | Use when |
| --- | --- | --- |
| `EmptyState` | `(icon, title, message, modifier, actionLabel, actionSemanticsLabel, onAction, footer)` | The first-run or nothing-here column of a list. |
| `StatusChip` | `(label, color: Color, modifier)` / `(label, tone: StatusTone, modifier)` | The compact status pill on a row. Ellipsizes at 128dp rather than pushing the title off screen. |
| `RefreshErrorTile` | `(message: String, onRetry, retrySemanticsLabel, modifier)` / `(error: Throwable, onRetry, retrySemanticsLabel, modifier, serverHost)` | The list is still showing last-known data. Prefer the `Throwable` overload: it goes through `FriendlyError`. |
| `UnsupportedListItemCard` | `(modifier, itemName = "item")` | A row this build could not decode. |
| `UnsupportedListItemCards` | `(rows: List<UnparsedRow>, modifier, itemName)` | The `unparsedRows` a `DecodedList` handed back. |
| `AdaptiveRefreshButton` | `(label, onClick, modifier)` | A top-bar refresh action. Renders nothing on a phone, where pull-to-refresh is the affordance. |
| `PlainTextEditor` | `(value, onValueChange, accessibilityLabel, modifier, minHeight = 100.dp, enabled)` | Shell scripts and JSON. Every keyboard substitution is off. |
| `SecretEntryFields` | `(name, onNameChange, value, onValueChange, semanticsPrefix, isSaving, onSave, modifier, enabled)` | Entering one write-only secret, with validation and the Save action. |
| `SecretValueField` | `(value, onValueChange, semanticsPrefix, modifier, enabled, focusRequester, imeAction, onSubmit)` | Just the value half, with its show/hide control. |

`semanticsPrefix` is the noun the field belongs to — `"User secret"`,
`"Organization secret"` — and every accessible name is built from it:
`"$prefix name"`, `"$prefix value"`, `"Save ${prefix.lowercase()}"`.

## Test handles

`Modifier.testTag(...)` is set on the containers a UI test needs to find:
`app-list` (via `Modifier.appListTestTag()` / `AppListTestTag`),
`app-back-button`, `app-close-button`, `app-floating-action`,
`app-confirm-dialog`, `app-notice-dialog`, `app-sheet`,
`app-option-picker-$label`, `empty-state`, `refresh-error-tile`,
`unsupported-list-item`, `plain-text-editor`, `save-secret`.

## Not ported

- `platform.dart` (`usesAppleDesign` / `usesMacDesign`): the Android build only
  ever takes the Material branch, so every one of those choices collapsed to a
  constant and the seam is gone rather than always-false.
- `AppIconButton.tooltip`: a hover affordance with nothing to hover on. The
  accessible name is the single naming channel on a phone.
- `AppListTile.isThreeLine`: Material 3's `ListItem` sizes itself from its
  content, so there is nothing to declare.
- `ContentPane` / `CollectionPane` and `kContentMaxWidth` /
  `kCollectionMaxWidth` live in `lib/shell/layout_constants.dart` and belong to
  the shell, not here. `CompactWidthBreakpoint` is here because the widgets
  above branch on it.
