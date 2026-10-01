package com.pipod.app.core.session

import android.view.KeyCharacterMap
import android.view.KeyEvent

/**
 * Translates Android key events into the raw bytes pi-tui would have read from
 * stdin. Extension components in the pod run against a real terminal input
 * stream, so the app has to speak the same sequences a terminal emits.
 *
 * Port of `pi-pod-flutter/lib/core/session/remote_ui_input.dart`. Flutter handed
 * the encoder a layout-resolved `LogicalKeyboardKey`; Android reports a physical
 * key code plus a modifier state, so the encoder takes both and stays a pure
 * function of them.
 */
object RemoteUiKeys {

    /** Convenience for the Compose layer; a key-up produces nothing. */
    fun fromKeyEvent(event: KeyEvent): String? {
        if (event.action == KeyEvent.ACTION_UP) return null
        return encode(
            keyCode = event.keyCode,
            character = event.printableCharacter(),
            control = event.isCtrlPressed,
            alt = event.isAltPressed,
            shift = event.isShiftPressed,
            meta = event.isMetaPressed,
        )
    }

    /**
     * Returns null for keys a terminal does not report at all (bare modifiers,
     * media keys), so the caller can leave them to the app's own shortcuts.
     */
    fun encode(
        keyCode: Int,
        character: String? = null,
        control: Boolean = false,
        alt: Boolean = false,
        shift: Boolean = false,
        meta: Boolean = false,
    ): String? {
        if (keyCode in MODIFIERS) return null
        // A command-key chord belongs to the app (copy, paste, quit), not the pod.
        if (meta) return null

        val named = named(keyCode, shift = shift)
        if (named != null) return if (alt) "\u001b$named" else named

        if (control) {
            val controlled = control(keyCode, character, shift = shift) ?: return null
            return if (alt) "\u001b$controlled" else controlled
        }

        // Control characters produced by the platform itself are already terminal
        // data; passing them through keeps Ctrl chords working where the embedder
        // reports them instead of the modifier state.
        val text = character
        if (text.isNullOrEmpty()) return null
        return if (alt) "\u001b$text" else text
    }

    private fun named(keyCode: Int, shift: Boolean): String? = when (keyCode) {
        KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "\r"
        KeyEvent.KEYCODE_TAB -> if (shift) "\u001b[Z" else "\t"
        KeyEvent.KEYCODE_DEL -> "\u007f"
        KeyEvent.KEYCODE_ESCAPE -> "\u001b"
        KeyEvent.KEYCODE_FORWARD_DEL -> "\u001b[3~"
        KeyEvent.KEYCODE_INSERT -> "\u001b[2~"
        KeyEvent.KEYCODE_DPAD_UP -> "\u001b[A"
        KeyEvent.KEYCODE_DPAD_DOWN -> "\u001b[B"
        KeyEvent.KEYCODE_DPAD_RIGHT -> "\u001b[C"
        KeyEvent.KEYCODE_DPAD_LEFT -> "\u001b[D"
        KeyEvent.KEYCODE_MOVE_HOME -> "\u001b[H"
        KeyEvent.KEYCODE_MOVE_END -> "\u001b[F"
        KeyEvent.KEYCODE_PAGE_UP -> "\u001b[5~"
        KeyEvent.KEYCODE_PAGE_DOWN -> "\u001b[6~"
        else -> FUNCTION_KEYS[keyCode]
    }

    private fun control(keyCode: Int, character: String?, shift: Boolean): String? {
        val label = printableLabel(keyCode, shift = shift)
        if (label != null) {
            if (label.code in 0x61..0x7a) return (label.code - 0x60).toChar().toString()
            CONTROL_PUNCTUATION[label]?.let { return it }
        }
        if (character != null && character.length == 1 && character[0].code < 0x20) return character
        return null
    }

    /**
     * The label the key would print, which is what the Dart original read off
     * `LogicalKeyboardKey.keyLabel`. Android leaves the shifted form of a
     * punctuation key to the caller's modifier state, so it is resolved here.
     */
    private fun printableLabel(keyCode: Int, shift: Boolean): Char? = when (keyCode) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 'a' + (keyCode - KeyEvent.KEYCODE_A)
        KeyEvent.KEYCODE_SPACE -> ' '
        KeyEvent.KEYCODE_LEFT_BRACKET -> '['
        KeyEvent.KEYCODE_RIGHT_BRACKET -> ']'
        KeyEvent.KEYCODE_BACKSLASH -> '\\'
        KeyEvent.KEYCODE_SLASH -> if (shift) '?' else '/'
        KeyEvent.KEYCODE_MINUS -> if (shift) '_' else '-'
        KeyEvent.KEYCODE_AT -> '@'
        else -> null
    }

    /** A dead key reports its accent in the high bits and prints nothing yet. */
    private fun KeyEvent.printableCharacter(): String? {
        val code = unicodeChar
        if (code == 0 || code and KeyCharacterMap.COMBINING_ACCENT != 0) return null
        return code.toChar().toString()
    }

    private val CONTROL_PUNCTUATION: Map<Char, String> = mapOf(
        '[' to "\u001b",
        ']' to "\u001d",
        '\\' to "\u001c",
        '_' to "\u001f",
        '/' to "\u001f",
        '@' to "\u0000",
        ' ' to "\u0000",
        '?' to "\u007f",
    )

    private val FUNCTION_KEYS: Map<Int, String> = mapOf(
        KeyEvent.KEYCODE_F1 to "\u001bOP",
        KeyEvent.KEYCODE_F2 to "\u001bOQ",
        KeyEvent.KEYCODE_F3 to "\u001bOR",
        KeyEvent.KEYCODE_F4 to "\u001bOS",
        KeyEvent.KEYCODE_F5 to "\u001b[15~",
        KeyEvent.KEYCODE_F6 to "\u001b[17~",
        KeyEvent.KEYCODE_F7 to "\u001b[18~",
        KeyEvent.KEYCODE_F8 to "\u001b[19~",
        KeyEvent.KEYCODE_F9 to "\u001b[20~",
        KeyEvent.KEYCODE_F10 to "\u001b[21~",
        KeyEvent.KEYCODE_F11 to "\u001b[23~",
        KeyEvent.KEYCODE_F12 to "\u001b[24~",
    )

    private val MODIFIERS: Set<Int> = setOf(
        KeyEvent.KEYCODE_CTRL_LEFT,
        KeyEvent.KEYCODE_CTRL_RIGHT,
        KeyEvent.KEYCODE_SHIFT_LEFT,
        KeyEvent.KEYCODE_SHIFT_RIGHT,
        KeyEvent.KEYCODE_ALT_LEFT,
        KeyEvent.KEYCODE_ALT_RIGHT,
        KeyEvent.KEYCODE_META_LEFT,
        KeyEvent.KEYCODE_META_RIGHT,
        KeyEvent.KEYCODE_CAPS_LOCK,
        KeyEvent.KEYCODE_NUM_LOCK,
        KeyEvent.KEYCODE_SCROLL_LOCK,
        KeyEvent.KEYCODE_FUNCTION,
        KeyEvent.KEYCODE_SYM,
    )
}
