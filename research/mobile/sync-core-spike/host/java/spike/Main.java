// The Hermes host's way in: Android's Java runtime, as an app gives it.
//
// Hermes on Android hands String.prototype.normalize, localeCompare, case
// conversion beyond ASCII and date formatting to Java (the hermes-android
// AAR's com.facebook.hermes.unicode.AndroidUnicodeUtils, over fbjni), and
// runs native finalizers on a thread it attaches to the VM. A plain program
// under `adb shell` has no VM, so the host is a library run from here:
//
//   CLASSPATH=<dir>/spike.dex app_process -Dspike.dir=<dir> <dir> spike.Main core.hbc -- <args>
//
// The libraries load in dependency order; fbjni's JNI_OnLoad keeps the VM
// for Hermes. The host prints and exits itself (host/host-hermes.cpp).

package spike;

public final class Main {
	private Main() {}

	public static void main(String[] args) {
		String dir = System.getProperty("spike.dir");
		if (dir == null) throw new IllegalStateException("start with -Dspike.dir=<the folder holding the libraries>");
		for (String lib : new String[] { "c++_shared", "fbjni", "jsi", "hermesvm", "spikehost" }) System.load(dir + "/lib" + lib + ".so");
		System.exit(run(args));
	}

	private static native int run(String[] args);
}
