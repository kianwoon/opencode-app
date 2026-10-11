# macOS ctypes probes: missing argtypes on CF calls = SIGSEGV, not an exception

- **Date**: 2026-10-11T15:02:14+0800
- **Type**: lesson

## What happened

Python 3.14.7 + raw ctypes CDLL(CoreFoundation): calling CFStringGetCString with restype but NO argtypes truncates the CF pointer to 32 bits (3.14.7 live-verified: labs(0x164aed9f3) -> 0x64aed9f3 without argtypes, intact with argtypes=[c_long]). Result: EXC_BAD_ACCESS in __CF_IS_OBJC/CFStringGetCString via libffi — a macOS crash-report dialog, no Python traceback. Cost a full crash triage.

## Root cause / fix

Declare BOTH restype and argtypes on EVERY CoreFoundation/CoreGraphics ctypes call, before first use (argtypes=[c_void_p,...] for object-taking fns; restype=c_void_p for create/copy fns). Better: use PyObjC (Quartz is installed) which returns real Python objects. Acceptance gate: a probe script that lists windows runs to completion with zero crash-report dialogs; grep the script for 'CDLL' — every function object must have .argtypes set.
