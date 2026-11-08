//! Windows MMCSS registration for the cpal output thread.
//!
//! cpal 0.15 runs the WASAPI render loop on an ordinary thread. It tries to
//! raise it to TIME_CRITICAL, but passes the thread *id* where a handle is
//! expected, so that call silently fails and the audio thread competes with
//! everything else in the process at normal priority. On a loaded laptop
//! (Hyper-V/WSL2 root partition, a busy renderer, the odd DPC spike) that is
//! enough to miss a 10 ms WASAPI period — heard as cracks, worst on USB
//! interfaces such as the DDJ-FLX10 whose driver buffer is kept tiny for
//! rekordbox and cannot absorb a late callback.
//!
//! MMCSS ("Pro Audio" task) is what every Windows DAW and Chromium's own audio
//! thread use: the scheduler gives the registered thread a reserved real-time
//! priority band for the thread's lifetime. Registration is per-thread, so it
//! is done lazily from inside the first callback on each stream thread (cpal
//! spawns a fresh thread per stream rebuild). The returned handle is leaked on
//! purpose — the registration should live exactly as long as the thread.
//!
//! Linked straight against avrt.dll rather than pulling the `windows` crate
//! in for one function.

#[cfg(windows)]
mod imp {
    use std::cell::Cell;
    use std::ffi::c_void;

    #[link(name = "avrt")]
    extern "system" {
        fn AvSetMmThreadCharacteristicsW(
            task_name: *const u16,
            task_index: *mut u32,
        ) -> *mut c_void;
    }

    thread_local! {
        static REGISTERED: Cell<bool> = const { Cell::new(false) };
    }

    pub fn register_current_thread() {
        REGISTERED.with(|done| {
            if done.get() {
                return;
            }
            // Mark first: a failed attempt must not be retried every callback.
            done.set(true);
            let name: Vec<u16> = "Pro Audio".encode_utf16().chain(std::iter::once(0)).collect();
            let mut task_index: u32 = 0;
            let handle = unsafe { AvSetMmThreadCharacteristicsW(name.as_ptr(), &mut task_index) };
            if handle.is_null() {
                let err = std::io::Error::last_os_error();
                tracing::warn!(?err, "MMCSS registration failed — audio thread stays at normal priority");
            } else {
                tracing::info!("audio thread registered with MMCSS (Pro Audio)");
            }
        });
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn register_current_thread() {}
}

pub use imp::register_current_thread;
