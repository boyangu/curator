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

// Configuration as the desktop build reads it: the environment (what
// scripts/release-mobile.mjs passes), else the repo's git-ignored .env.
// Never in git.
val dotEnv: Map<String, String> = rootDir.resolve("../../../.env").takeIf { it.exists() }?.readLines().orEmpty()
	.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") && "=" in it }
	.associate { it.substringBefore("=").trim() to it.substringAfter("=").trim().trim('"', '\'') }
fun config(name: String): String = System.getenv(name)?.takeIf { it.isNotBlank() } ?: dotEnv[name] ?: ""

// The Spotify app the desktop uses. Empty: Spotify playback reports itself
// unconfigured. The redirect URI is registered on that app with this package
// and each signing key's SHA-1 (Android packages, in Spotify's dashboard).
val spotifyClientId = config("CURATOR_SPOTIFY_CLIENT_ID")

// Curator's cloud, as the desktop build reads it. Empty: the app says it isn't
// set up and goes no further.
val cloudApiUrl = config("CURATOR_CLOUD_API_URL").trimEnd('/')
val supabaseUrl = config("CURATOR_SUPABASE_URL").trimEnd('/')
val supabaseKey = config("CURATOR_SUPABASE_PUBLISHABLE_KEY")

// Where released builds look for their updates: the release list of the
// GitHub repo ("owner/name") whose mobile-v* releases carry them
// (scripts/release-mobile.mjs). CURATOR_MOBILE_UPDATE_FEED names another list
// of the same shape instead (a local test feed through adb reverse); a
// release never sets it. Empty: the updater reports itself unconfigured.
val updateRepo = config("CURATOR_MOBILE_UPDATE_REPO")
val updateFeed = config("CURATOR_MOBILE_UPDATE_FEED").ifEmpty { if (updateRepo.isEmpty()) "" else "https://api.github.com/repos/$updateRepo/releases?per_page=30" }

// The release's version, from its tag (mobile-v1.2.3 → -PcuratorVersion=1.2.3);
// a build without one is a development build. The code orders releases for
// Android and the updater: 1.2.3 → 1_002_003.
val curatorVersion = (findProperty("curatorVersion") as String?)?.takeIf { it.isNotBlank() }
val versionParts = curatorVersion?.let { v ->
	requireNotNull(Regex("""^(\d+)\.(\d+)\.(\d+)$""").find(v)) { "curatorVersion must be X.Y.Z, got $v" }.groupValues.drop(1).map { it.toInt() }
}

// The release key (scripts/release-mobile.mjs checks the APK was signed with
// it): a PKCS12 keystore kept off GitHub, its path and password in the
// environment or .env. Without it a release build is signed with the debug
// key, for local runs.
val releaseKeystore = config("CURATOR_MOBILE_KEYSTORE").takeIf { it.isNotEmpty() }?.let { file(it) }

android {
	namespace = "app.curator.mobile"
	compileSdk = 35
	ndkVersion = "26.1.10909125"

	defaultConfig {
		applicationId = "app.curator.mobile"
		minSdk = 29
		targetSdk = 35
		versionCode = versionParts?.let { (major, minor, patch) -> major * 1_000_000 + minor * 1_000 + patch } ?: 1
		versionName = curatorVersion ?: "0.0.0-dev"
		ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
		buildConfigField("String", "SPOTIFY_CLIENT_ID", "\"$spotifyClientId\"")
		buildConfigField("String", "SPOTIFY_REDIRECT_URI", "\"curator-mobile://spotify-callback\"")
		buildConfigField("String", "UPDATE_FEED", "\"$updateFeed\"")
		buildConfigField("String", "CLOUD_API_URL", "\"$cloudApiUrl\"")
		buildConfigField("String", "SUPABASE_URL", "\"$supabaseUrl\"")
		buildConfigField("String", "SUPABASE_PUBLISHABLE_KEY", "\"$supabaseKey\"")
		// Only a development build may be pointed at another cloud (core/CloudConfig.kt).
		buildConfigField("boolean", "DEV_SERVER", "${curatorVersion == null}")
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

	signingConfigs {
		if (releaseKeystore != null) create("release") {
			storeFile = releaseKeystore
			storeType = "PKCS12"
			// One password: a PKCS12 store's key has the store's.
			storePassword = config("CURATOR_MOBILE_KEYSTORE_PASSWORD")
			keyAlias = config("CURATOR_MOBILE_KEY_ALIAS").ifEmpty { "curator" }
			keyPassword = config("CURATOR_MOBILE_KEYSTORE_PASSWORD")
		}
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			// The release build starts in 0.5 s where the debuggable one takes 3,
			// so local runs use it too, with the debug key.
			signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
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
	implementation(libs.nativeloader)
	implementation(files(vendorDir.resolve("spotify/spotify-app-remote-release-0.8.0.aar")))
	// App Remote maps its protocol with Gson.
	implementation(libs.gson)
	// The one-time consent, asked from our activity (see player/AppPlayer.kt).
	implementation(libs.spotify.auth)
	testImplementation(libs.junit)
	testImplementation(libs.sqlite.jdbc)
}
