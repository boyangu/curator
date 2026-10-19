import numpy as np
import pytest

from curator_mir.pooling import (TimedVectors, bin_frames, equal_windows, from_b64, l2n,
                                 pool_segments, to_b64)


def test_equal_windows_short_track_is_one_window():
    assert equal_windows(10 * 24000, 24000, 360.0) == [(0, 240000)]


def test_equal_windows_splits_evenly_not_max_then_scrap():
    n = 370 * 24000  # 6:10 -> two ~185 s windows, never 360 s + 10 s
    wins = equal_windows(n, 24000, 360.0)
    assert len(wins) == 2
    assert wins[0][0] == 0 and wins[-1][1] == n
    assert abs((wins[0][1] - wins[0][0]) - (wins[1][1] - wins[1][0])) <= 1
    assert all(b - a <= 360 * 24000 for a, b in wins)


def test_bin_frames_times_and_means():
    frames = np.arange(60, dtype=np.float32).reshape(60, 1)  # 2.4 s at 25 Hz
    tv = bin_frames(frames, 25.0, offset_secs=10.0)
    assert tv.vecs.shape == (3, 1)
    np.testing.assert_allclose(tv.starts, [10.0, 11.0, 12.0])
    np.testing.assert_allclose(tv.ends, [11.0, 12.0, 12.4])
    np.testing.assert_allclose(tv.vecs[:, 0], [12.0, 37.0, 54.5])


def test_pool_segments_overlap_weighted():
    tv = TimedVectors(np.array([0.0, 10.0]), np.array([10.0, 20.0]), np.array([[1.0], [3.0]], dtype=np.float32))
    whole, half, outside = pool_segments(tv, [
        {"startSec": 0, "endSec": 20}, {"startSec": 5, "endSec": 20}, {"startSec": 30, "endSec": 40}])
    assert whole[0] == pytest.approx(2.0)
    assert half[0] == pytest.approx((5 * 1 + 10 * 3) / 15)
    assert outside is None


def test_b64_roundtrip_is_float32_le():
    v = np.array([0.5, -1.25, 3.0], dtype=np.float64)
    out = from_b64(to_b64(v))
    assert out.dtype == np.dtype("<f4")
    np.testing.assert_array_equal(out, v.astype(np.float32))


def test_l2n_handles_zero_rows():
    x = l2n(np.array([[3.0, 4.0], [0.0, 0.0]]))
    np.testing.assert_allclose(x[0], [0.6, 0.8])
    np.testing.assert_array_equal(x[1], [0.0, 0.0])
