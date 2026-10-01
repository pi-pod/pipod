package com.pipod.app.core.api

import kotlinx.serialization.json.Json

/**
 * The one JSON codec the client uses.
 *
 * `ignoreUnknownKeys` is deliberate: the server ships fields ahead of the
 * clients that read them, and a build that refuses an unknown key would break
 * on every server deploy. `explicitNulls = false` keeps optional request fields
 * out of the body instead of sending `null`, which some routes treat as "clear
 * this" rather than "leave it alone".
 */
val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = false
    coerceInputValues = false
    encodeDefaults = true
}
