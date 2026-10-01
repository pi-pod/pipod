import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Build-time configuration, the native equivalent of Flutter's `--dart-define`.
 *
 * Every value can be overridden with `-P<name>=value` on the Gradle command line
 * (this is the contract the workspace Makefile's `make android` target uses) or
 * with an environment variable of the same name. Defaults match
 * `pi-pod-flutter/lib/core/config.dart` so the two clients behave identically.
 */
fun buildConfigValue(vararg properties: String, environmentKey: String, default: String): String {
    for (property in properties) {
        val fromProperty = providers.gradleProperty(property).orNull
        if (!fromProperty.isNullOrEmpty()) return fromProperty
    }
    val fromEnvironment = providers.environmentVariable(environmentKey).orNull
    if (!fromEnvironment.isNullOrEmpty()) return fromEnvironment
    return default
}

fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

/** Release signing comes from `keystore.properties` or the matching environment variables. */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingValue(key: String, environmentKey: String): String? =
    keystoreProperties.getProperty(key)?.takeIf { it.isNotEmpty() }
        ?: providers.environmentVariable(environmentKey).orNull?.takeIf { it.isNotEmpty() }

/** `-PpipodServerUrl` / `PIPOD_SERVER_URL` win; otherwise the build type's own default. */
fun serverUrl(default: String) =
    buildConfigValue("pipodServerUrl", environmentKey = "PIPOD_SERVER_URL", default = default)

// A dev JWT must never reach a release artifact. Injecting one is a debug-only
// affordance, so asking for both at once is a build error rather than a quiet drop.
val devTokenRequested =
    !providers.gradleProperty("pipodDevToken").orNull.isNullOrEmpty() ||
        !providers.environmentVariable("PIPOD_DEV_TOKEN").orNull.isNullOrEmpty()
gradle.taskGraph.whenReady {
    val releaseTask = allTasks.firstOrNull { it.name.contains("Release") && it.project.path == ":app" }
    if (devTokenRequested && releaseTask != null) {
        throw GradleException(
            "pipodDevToken/PIPOD_DEV_TOKEN is set while building '${releaseTask.name}'. " +
                "The dev-token sign-in bypass is debug-only; unset it or build a debug variant.",
        )
    }
}

android {
    // Play identity is `com.pipod` (user-corrected). `namespace` stays
    // `com.pipod.app`: it is only the Kotlin/R package, independent of the
    // Play applicationId, so renaming it would churn every source file.
    namespace = "com.pipod.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.pipod"
        minSdk = 26
        targetSdk = 36
        versionCode = buildConfigValue(
            "versionCode", "pipodVersionCode",
            environmentKey = "PIPOD_VERSION_CODE", default = "1",
        ).toInt()
        versionName = buildConfigValue(
            "versionName", "pipodVersionName",
            environmentKey = "PIPOD_VERSION_NAME", default = "0.1.0",
        )

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Release defaults to production; debug defaults to the loopback server the
        // Makefile exposes with `adb reverse tcp:8080`. Overridden per build type below.
        buildConfigField("String", "PIPOD_SERVER_URL", quoted(serverUrl("https://api.pipod.dev")))
        buildConfigField(
            "String",
            "PIPOD_OIDC_ISSUER",
            quoted(
                buildConfigValue(
                    "pipodOidcIssuer",
                    environmentKey = "PIPOD_OIDC_ISSUER",
                    default = "https://auth.pipod.dev",
                ),
            ),
        )
        buildConfigField(
            "String",
            "PIPOD_OIDC_MOBILE_CLIENT_ID",
            quoted(
                buildConfigValue(
                    "pipodOidcMobileClientId",
                    environmentKey = "PIPOD_OIDC_MOBILE_CLIENT_ID",
                    default = "388199923079774215",
                ),
            ),
        )
        buildConfigField(
            "String",
            "PIPOD_OIDC_MOBILE_REDIRECT_URI",
            quoted(
                buildConfigValue(
                    "pipodOidcMobileRedirectUri",
                    environmentKey = "PIPOD_OIDC_MOBILE_REDIRECT_URI",
                    default = "pipod://auth/callback",
                ),
            ),
        )
        // The dev-token bypass exists only in the debug build type below. Release
        // builds compile a constant empty string, so there is nothing to override.
        buildConfigField("String", "PIPOD_DEV_TOKEN", "\"\"")
    }

    val releaseStoreFile = signingValue("storeFile", "PIPOD_KEYSTORE_FILE")
    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = signingValue("storePassword", "PIPOD_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "PIPOD_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "PIPOD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "PIPOD_SERVER_URL", quoted(serverUrl("http://localhost:8080")))
            // A dev JWT and a plain-HTTP server are debug-only affordances. Nothing is
            // baked in by default: the Makefile passes the JWT as an intent extra, which
            // MainActivity honours only when BuildConfig.DEBUG is true. -PpipodDevToken
            // stays available for a one-off build that wants it compiled in.
            buildConfigField(
                "String",
                "PIPOD_DEV_TOKEN",
                quoted(
                    buildConfigValue(
                        "pipodDevToken",
                        environmentKey = "PIPOD_DEV_TOKEN",
                        default = "",
                    ),
                ),
            )
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // No silent debug-key fallback. Without a configured keystore the release
            // variant builds unsigned, which is enough for a compile/shrink check and
            // cannot be mistaken for a shippable artifact.
            signingConfig = signingConfigs.findByName("release")
        }
        // Non-shipping. Same server/OIDC/signing/DEBUG=false as release, unshrunk
        // so androidTest has a complete classloader. Not Play; not live auth.
        create("instrumentedRelease") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    // AuthGate/SessionStore integration smoke uses the non-shipping instrumentedRelease pair.
    // Production assembleRelease stays minify+shrink without the test host.
    testBuildType = "instrumentedRelease"

    sourceSets {
        getByName("main").java.srcDirs("src/main/kotlin")
        getByName("androidTest").java.srcDirs("src/androidTest/kotlin")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.browser)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.window.size)
    implementation(libs.compose.material.icons.extended)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
    add("instrumentedReleaseImplementation", libs.compose.ui.test.manifest)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.uiautomator)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4)
    // Instrumented tests use `kotlin.test` assertions.
    androidTestImplementation(libs.kotlin.test.junit)
    // The OIDC round trip is written in `android.net.Uri`, so the sign-in
    // lifecycle can only be exercised here — and exercising it honestly means
    // a real discovery document, a real token endpoint and a real signed ID
    // token rather than a stubbed `OidcClient`.
    androidTestImplementation(libs.okhttp.mockwebserver)
}
