cmake_minimum_required(VERSION 3.22.1)
project(curator LANGUAGES C CXX)

# CURATOR_VENDOR: apps/mobile/vendor (scripts/fetch-vendor.mjs), passed by
# app/build.gradle.kts.
set(SQLITE_DIR ${CURATOR_VENDOR}/sqlite)
set(JSI_DIR ${CURATOR_VENDOR}/hermes/jsi)

# Hermes from the hermes-android AAR (prefab); fbjni comes with it at run time.
find_package(hermes-engine REQUIRED CONFIG)

# libhermesvm.so needs libjsi.so, which the AAR leaves to the app: built here
# from the engine's own tag.
add_library(jsi SHARED ${JSI_DIR}/jsi/jsi.cpp)
target_include_directories(jsi PUBLIC ${JSI_DIR})
target_compile_options(jsi PRIVATE -O2 -fexceptions -frtti -w)
set_target_properties(jsi PROPERTIES CXX_STANDARD 20)

# The one SQLite in the process, as better-sqlite3 builds it (the desktop's
# options), so the sync core's SQL behaves the same here as there. Multi-
# thread mode: a connection is never used by two threads at once (the JS
# thread owns the core's, Kotlin's readers lock theirs).
add_library(sqlite STATIC ${SQLITE_DIR}/sqlite3.c)
target_include_directories(sqlite PUBLIC ${SQLITE_DIR})
target_compile_definitions(sqlite PRIVATE
	SQLITE_DQS=0 SQLITE_DEFAULT_FOREIGN_KEYS=1 SQLITE_DEFAULT_RECURSIVE_TRIGGERS=1 SQLITE_DEFAULT_CACHE_SIZE=-16000
	SQLITE_DEFAULT_MEMSTATUS=0 SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 SQLITE_LIKE_DOESNT_MATCH_BLOBS SQLITE_THREADSAFE=2
	SQLITE_TEMP_STORE=1 SQLITE_USE_URI=1 SQLITE_OMIT_DEPRECATED SQLITE_OMIT_SHARED_CACHE SQLITE_OMIT_PROGRESS_CALLBACK
	SQLITE_ENABLE_FTS3 SQLITE_ENABLE_FTS3_PARENTHESIS SQLITE_ENABLE_FTS4 SQLITE_ENABLE_FTS5 SQLITE_ENABLE_RTREE
	SQLITE_ENABLE_GEOPOLY SQLITE_ENABLE_MATH_FUNCTIONS SQLITE_ENABLE_STAT4 SQLITE_ENABLE_COLUMN_METADATA
	SQLITE_ENABLE_DBSTAT_VTAB SQLITE_SOUNDEX SQLITE_DEFAULT_SECTOR_SIZE=4096)
target_compile_options(sqlite PRIVATE -O2 -w -fPIC)

add_library(curator SHARED js_host.cpp db_jni.cpp)
target_compile_options(curator PRIVATE -O2 -fexceptions -frtti -Wall)
set_target_properties(curator PROPERTIES CXX_STANDARD 20)
target_link_libraries(curator hermes-engine::hermesvm jsi sqlite z log android)
