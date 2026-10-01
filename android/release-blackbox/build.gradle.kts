plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.pipod.releaseblackbox"
    compileSdk = 37

    defaultConfig {
        // This is a disposable, self-instrumented test host. It is deliberately
        // not com.pipod: the production Release APK is installed and driven as
        // an external application by UiAutomator.
        applicationId = "com.pipod.releaseblackbox.runner"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("androidTest").java.srcDirs("src/androidTest/kotlin")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // Intentionally androidTest-only and self-contained. In particular there is
    // no project(":app"), Compose, Espresso, or production-app dependency.
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.uiautomator)
}
