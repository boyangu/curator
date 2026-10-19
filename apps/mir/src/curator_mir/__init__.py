"""Curator's AI audio analysis engine.

MIR_VERSION is the engine release and PROTOCOL_VERSION the stdio wire format
(the Node host refuses a sidecar announcing a different protocol). Stored
vectors are NOT keyed by either: each model adapter carries its own version in
registry.py, so bumping one model never invalidates another model's vectors.
"""

MIR_VERSION = "0.1.0"
PROTOCOL_VERSION = 1
