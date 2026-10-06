#!/usr/bin/python3
"""Self-owned native acceptance window. Never types into existing applications."""
import ctypes as C
import json
import select
import time


class Key(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send', C.c_int), ('display', C.c_void_p),
                ('window', C.c_ulong), ('root', C.c_ulong), ('subwindow', C.c_ulong), ('time', C.c_ulong),
                ('x', C.c_int), ('y', C.c_int), ('xroot', C.c_int), ('yroot', C.c_int),
                ('state', C.c_uint), ('code', C.c_uint), ('same', C.c_int)]


class Event(C.Union):
    _fields_ = [('type', C.c_int), ('key', Key), ('pad', C.c_long * 24)]


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


x = C.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [C.c_char_p]
x.XOpenDisplay.restype = C.c_void_p
x.XDefaultRootWindow.argtypes = [C.c_void_p]
x.XDefaultRootWindow.restype = C.c_ulong
x.XCreateSimpleWindow.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong]
x.XCreateSimpleWindow.restype = C.c_ulong
x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
x.XStoreName.argtypes = [C.c_void_p, C.c_ulong, C.c_char_p]
x.XMapRaised.argtypes = [C.c_void_p, C.c_ulong]
x.XFlush.argtypes = [C.c_void_p]
x.XPending.argtypes = [C.c_void_p]
x.XNextEvent.argtypes = [C.c_void_p, C.POINTER(Event)]
x.XSetInputFocus.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_ulong]
x.XTranslateCoordinates.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)]
x.XLookupKeysym.argtypes = [C.POINTER(Key), C.c_int]
x.XLookupKeysym.restype = C.c_ulong
x.XRefreshKeyboardMapping.argtypes = [C.POINTER(Event)]
x.XDestroyWindow.argtypes = [C.c_void_p, C.c_ulong]
x.XCloseDisplay.argtypes = [C.c_void_p]
display = x.XOpenDisplay(b':1')
if not display:
    raise RuntimeError('Test desktop unavailable')
root = x.XDefaultRootWindow(display)
window = x.XCreateSimpleWindow(display, root, 300, 280, 460, 200, 1, 0, 0x2080E0)
x.XStoreName(display, window, b'OpenCraft input acceptance - test window')
x.XSelectInput(display, window, 1 | 2 | 4 | 8 | 64 | 131072)
x.XMapRaised(display, window)
x.XFlush(display)
try:
    # Let the real WM place the window; report actual root coordinates.
    time.sleep(0.5)
    px, py, child = C.c_int(), C.c_int(), C.c_ulong()
    if not x.XTranslateCoordinates(display, window, root, 80, 80, C.byref(px), C.byref(py), C.byref(child)):
        raise RuntimeError('Test window unavailable')
    emit({'event': 'ready', 'x': px.value, 'y': py.value})
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if not x.XPending(display):
            time.sleep(0.01)
            continue
        event = Event()
        x.XNextEvent(display, C.byref(event))
        if event.type == 34:
            x.XRefreshKeyboardMapping(C.byref(event))
            continue
        if event.type in (4, 5):
            if event.type == 4:
                x.XSetInputFocus(display, window, 1, 0)
                x.XFlush(display)
            emit({'event': 'button', 'down': event.type == 4, 'code': event.key.code})
        elif event.type in (2, 3):
            emit({'event': 'key', 'down': event.type == 2, 'symbol': x.XLookupKeysym(C.byref(event.key), 0)})
finally:
    x.XDestroyWindow(display, window)
    x.XCloseDisplay(display)
