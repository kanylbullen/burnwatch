import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * The deployment this APK talks to, read from a gitignored file.
 *
 * Typing a 32-character token on a watch is miserable, and the alternatives —
 * a companion phone app or a pairing-code round trip through the Worker — are
 * each larger than the complication itself. So a private build bakes the
 * credential in. That is only defensible because the token is read-only: it
 * opens GET /api/state and nothing else, so a lost watch cannot write invented
 * readings into the history. Never put a write token here.
 */
val tokenFile = rootProject.file("token.properties")
val secrets = Properties().apply {
    if (tokenFile.exists()) tokenFile.inputStream().use { load(it) }
}
val burnwatchUrl: String = (secrets.getProperty("BURNWATCH_URL") ?: "").trimEnd('/')
val burnwatchToken: String = secrets.getProperty("BURNWATCH_TOKEN") ?: ""

android {
    namespace = "io.github.kanylbullen.burnwatch.wear"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.kanylbullen.burnwatch.wear"
        // Wear OS 3. Complications exist further back, but the androidx
        // data-source API assumes the modern runtime.
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "BURNWATCH_URL", "\"$burnwatchUrl\"")
        buildConfigField("String", "BURNWATCH_TOKEN", "\"$burnwatchToken\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets.getByName("main") {
        java.srcDir("src/main/kotlin")
    }
    sourceSets.getByName("test") {
        java.srcDir("src/test/kotlin")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.wear.watchface:watchface-complications-data-source-ktx:1.2.1")
    implementation("androidx.wear.tiles:tiles:1.4.1")
    implementation("androidx.wear.protolayout:protolayout:1.2.1")
    implementation("androidx.wear.protolayout:protolayout-material:1.2.1")
    implementation("androidx.concurrent:concurrent-futures-ktx:1.2.0")
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    // android.jar's org.json is a stub that returns defaults under unit tests,
    // which would let a parser that never parses anything pass every test.
    testImplementation("org.json:json:20240303")
}

/**
 * Fail loudly rather than shipping an APK that can never authenticate. An
 * unconfigured build looks identical on the wrist to a broken network.
 */
tasks.register("checkToken") {
    doLast {
        require(burnwatchUrl.isNotEmpty() && burnwatchToken.isNotEmpty()) {
            "wear/token.properties is missing or incomplete — copy " +
                "token.properties.example and fill in your read-only token."
        }
    }
}

tasks.matching { it.name.startsWith("assemble") }.configureEach {
    dependsOn("checkToken")
}
