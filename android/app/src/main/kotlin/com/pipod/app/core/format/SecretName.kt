package com.pipod.app.core.format

/**
 * A secret is injected into pods as an environment variable, so its name has to
 * be a legal one: `^[A-Z_][A-Z0-9_]*$` (the server's rule). People type and
 * paste these the way the service that issued them writes them —
 * `anthropic-api-key`, `github token` — and the server's answer is a round trip
 * later and phrased for whoever wrote the validator. This fixes the name as it
 * is typed instead, and says what is left to fix when it cannot.
 *
 * The server's rule is ASCII (`ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/` in
 * `src/server/secrets/store.ts`) and its length bound is
 * [MAX_LENGTH]; both are enforced here rather than discovered from a 400.
 */
object SecretName {

    /** `SECRET_NAME_MAX_LENGTH` from `src/server/secrets/store.ts`. */
    const val MAX_LENGTH: Int = 128

    /**
     * The name as it will be sent: uppercased, with the separators people
     * actually type folded to underscores and anything else dropped.
     *
     * "Anything else" includes non-ASCII letters and digits. An environment
     * variable name is ASCII on the server, so keeping `Ä` or an Arabic-Indic
     * digit here would only move the refusal to the round trip this exists to
     * avoid.
     */
    fun normalized(raw: String): String {
        val folded = StringBuilder()
        val source = raw.trim().uppercase()
        var index = 0
        while (index < source.length) {
            val codePoint = source.codePointAt(index)
            index += Character.charCount(codePoint)
            var character = String(Character.toChars(codePoint))
            when (character) {
                "-", " ", ".", "/", ":" -> character = "_"
            }
            if (isAsciiNameChar(character)) folded.append(character)
        }
        // A name may not open with a digit, so a leading run of them cannot be kept.
        val name = folded.toString().trimStart { it in '0'..'9' }
        return if (name.length <= MAX_LENGTH) name else name.substring(0, MAX_LENGTH)
    }

    fun isValid(raw: String): Boolean {
        val name = normalized(raw)
        if (name.isEmpty()) return false
        val first = name[0]
        return first in 'A'..'Z' || first == '_'
    }

    /**
     * What is still wrong, for the person looking at the field. null once the
     * name is usable.
     */
    fun problem(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (isValid(trimmed)) return null
        return "A name needs a letter or underscore to start with — " +
            "pods receive it as an environment variable."
    }

    /**
     * Shown once the typed name and the name that will be saved differ, so
     * nobody has to guess what the field did to their input.
     */
    fun normalizationNotice(raw: String): String? {
        val trimmed = raw.trim()
        val name = normalized(trimmed)
        if (name.isEmpty() || name == trimmed) return null
        return "Saved as $name"
    }

    /** Exactly the alphabet `ENV_NAME_RE` admits. */
    private fun isAsciiNameChar(character: String): Boolean {
        if (character.length != 1) return false
        val value = character[0]
        return value in 'A'..'Z' || value in '0'..'9' || value == '_'
    }
}
