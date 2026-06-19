# vela-projection

`vela-projection` derives read models from canonical events.

It is a pure projection layer: it does not call backend adapters, does not append canonical events, and does not know about HTTP routing. This keeps transcript/activity/request behavior testable from an event list.
