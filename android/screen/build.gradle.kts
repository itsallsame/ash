// Screen capabilities and the native island are compiled into the Ash APK.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.ash.screen"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    defaultConfig {
        minSdk = 24
        buildConfigField("long", "VERSION_CODE", "${providers.gradleProperty("ashScreenVersionCode").get()}L")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { abortOnError = false; checkReleaseBuilds = false }
}

dependencies {
    implementation(project(":bridge"))
    // Spring physics for the island's transitions (SpringAnimation).
    implementation("androidx.dynamicanimation:dynamicanimation:1.0.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
