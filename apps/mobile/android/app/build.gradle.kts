import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
	alias(libs.plugins.android.application)
	alias(libs.plugins.kotlin.android)
	alias(libs.plugins.kotlin.compose)
	alias(libs.plugins.kotlin.serialization)
}

// What scripts/fetch-vendor.mjs fetched: SQLite's amalgamation, Hermes's JSI
// sources, Spotify's App Remote AAR. Hermes itself and fbjni come from Maven
// below (prefab).
val vendorDir = rootDir.resolve("../vendor").canonicalFile

// The Spotify app the desktop uses (its client id, from the repo's .env as the
// desktop build reads it; never in git). Empty: Spotify playback reports
// itself unconfigured. The redirect URI is registered on that app with this
// package and its signing SHA-1 (Android packages, in Spotify's dashboard).
val spotifyClientId: String = rootDir.resolve("../../../.env").takeIf { it.exists() }?.readLines()
	?.firstOrNull { it.startsWith("CURATOR_SPOTIFY_CLIENT_ID=") }?.substringAfter("=")?.trim()?.trim('"') ?: ""

android {
	namespace = "app.curator.mobile"
	compileSdk = 35
	ndkVersion = "26.1.10909125"

	defaultConfig {
		applicationId = "app.curator.mobile"
		minSdk = 29
		targetSdk = 35
		versionCode = 1
		versionName = "0.1.0"
		ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
		buildConfigField("String", "SPOTIFY_CLIENT_ID", "\"$spotifyClientId\"")
		buildConfigField("String", "SPOTIFY_REDIRECT_URI", "\"curator-mobile://spotify-callback\"")
		// The auth library's redirect activity answers that URI.
		manifestPlaceholders["redirectSchemeName"] = "curator-mobile"
		manifestPlaceholders["redirectHostName"] = "spotify-callback"
		manifestPlaceholders["redirectPathPattern"] = ".*"
		externalNativeBuild {
			cmake {
				arguments += listOf("-DANDROID_STL=c++_shared", "-DCURATOR_VENDOR=${vendorDir.invariantSeparatorsPath}")
			}
		}
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}

	buildFeatures {
		compose = true
		prefab = true
		buildConfig = true
	}

	externalNativeBuild {
		cmake {
			path = file("src/main/cpp/CMakeLists.txt")
			version = "3.22.1"
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	packaging {
		// fbjni's AAR and our own build both bring the NDK's C++ runtime.
		jniLibs { pickFirsts += "**/libc++_shared.so" }
	}
}

kotlin {
	compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
	implementation(platform(libs.compose.bom))
	implementation(libs.compose.ui)
	implementation(libs.compose.foundation)
	implementation(libs.compose.ui.tooling.preview)
	debugImplementation(libs.compose.ui.tooling)
	implementation(libs.activity.compose)
	implementation(libs.lifecycle.runtime.compose)
	implementation(libs.lifecycle.viewmodel.compose)
	implementation(libs.datastore.preferences)
	implementation(libs.coroutines.android)
	implementation(libs.serialization.json)
	// The release build of the engine in every build of the app: the AAR's
	// debug variant is an unoptimised VM with checks on, several times
	// slower at the core's work (a replica install, a pull).
	implementation(libs.hermes.android) {
		attributes { attribute(com.android.build.api.attributes.BuildTypeAttr.ATTRIBUTE, objects.named(com.android.build.api.attributes.BuildTypeAttr::class.java, "release")) }
	}
	implementation(libs.fbjni)
	implementation(files(vendorDir.resolve("spotify/spotify-app-remote-release-0.8.0.aar")))
	// App Remote maps its protocol with Gson.
	implementation(libs.gson)
	// The one-time consent, asked from our activity (see player/AppPlayer.kt).
	implementation(libs.spotify.auth)
	testImplementation(libs.junit)
}
