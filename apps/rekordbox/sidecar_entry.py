"""PyInstaller frozen-binary entry point.

Dev runs the sidecar as `python -m curator_rekordbox.main`, which executes
main.py *inside* its package so its relative imports (`from . import ...`)
resolve. PyInstaller pointed at main.py directly would run it as `__main__`
with no parent package — `ImportError: attempted relative import with no
known parent package`. This launcher imports the package absolutely (with
`--paths src` so `curator_rekordbox` is on the path) and calls main(),
preserving the package context the relative imports need.
"""

from curator_rekordbox.main import main

if __name__ == "__main__":
	main()
