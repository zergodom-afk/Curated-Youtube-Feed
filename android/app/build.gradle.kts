plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The filtering logic lives in ../../core (shared with the userscript and the
// tests). Bundle it into one asset so the app always ships the current version.
val coreDir = rootProject.layout.projectDirectory.dir("../core")
val coreFiles = listOf("classifier.js", "extractor.js", "policy.js", "curator.js")
val generatedAssets = layout.buildDirectory.dir("generated/mindfulAssets")

val bundleCore by tasks.registering {
    inputs.files(coreFiles.map { coreDir.file(it) })
    outputs.dir(generatedAssets)
    doLast {
        val out = generatedAssets.get().file("mindful-feed.js").asFile
        out.parentFile.mkdirs()
        out.writeText(coreFiles.joinToString("\n;\n") { name ->
            "// ---- core/$name ----\n" + coreDir.file(name).asFile.readText()
        })
    }
}

android {
    namespace = "app.mindfulfeed"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.mindfulfeed"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // R8 would strip the reflection the Anthropic SDK (Jackson) relies on.
            isMinifyEnabled = false
            // Signed with the debug key so the CI-built APK can be sideloaded.
            // Replace with your own signing config before publishing anywhere.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].assets.srcDir(generatedAssets)

    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/INDEX.LIST",
                "META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/*.kotlin_module",
            )
            pickFirsts += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/versions/9/module-info.class")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") { dependsOn(bundleCore) }

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.anthropic:anthropic-java:3.10.0")
}
