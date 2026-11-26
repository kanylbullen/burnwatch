/**
 * Code shared by every Kotlin client: today the Wear OS app, later the
 * Android phone widget (#4) and, through Kotlin/Native, the Apple apps (#5).
 *
 * The protocol logic is common code. The few primitives it needs (X25519,
 * HMAC-SHA256, SHA-256, AES-GCM) are `expect` declarations, because no
 * Kotlin standard library has them. Android and the JVM share one actual,
 * compiled into each target from src/jvmCommon: JCA for the hashes and
 * AES-GCM, Tink for X25519, since JCA only has it from Android 13 and the
 * watch app supports Wear OS 3.
 */

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("com.android.library")
}

kotlin {
    androidTarget {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    // The JVM target exists for the tests: they read protocol/vectors.json
    // from the repository, which an Android unit test could do too, but a
    // plain JVM test needs no Android toolchain to run.
    jvm {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
        androidMain {
            kotlin.srcDir("src/jvmCommon/kotlin")
            dependencies {
                implementation("com.google.crypto.tink:tink-android:1.15.0")
            }
        }
        jvmMain {
            kotlin.srcDir("src/jvmCommon/kotlin")
            dependencies {
                implementation("com.google.crypto.tink:tink:1.15.0")
            }
        }
    }
}

android {
    namespace = "io.github.kanylbullen.burnwatch.shared"
    compileSdk = 35
    defaultConfig {
        minSdk = 30
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.withType<Test>().configureEach {
    systemProperty("burnwatch.vectors", rootProject.file("../protocol/vectors.json").absolutePath)
}
